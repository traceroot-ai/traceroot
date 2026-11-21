import { Hono } from "hono";
import type { Agent } from "@earendil-works/pi-agent-core";
import { prisma, ModelSource } from "@traceroot/core";
import { existingFindingKeys } from "@traceroot/core/loops";
import {
  LOOP_LIMITS,
  type LoopAgentOutcome,
  type LoopAgentResult,
  type LoopRunModel,
} from "@traceroot/core/loops/pure";
import { publicErrorMessage } from "@traceroot/core/public-error";
import { getOrCreateAgent, removeAgent } from "./agent.js";
import { callerIdentity } from "./internal-auth.js";
import { getLoopSystemPrompt } from "./prompts/loop.js";
import {
  claimRun,
  releaseRun,
  runAgentStream,
  type AgentRunStream,
  type RunStreamResult,
} from "./run-stream.js";
import { ROOT_SPAN_NAME, turnTraceId, type AgentTraceMeta } from "./self-trace.js";
import { getSession, type SessionManager } from "./session.js";
import { newLoopRunState, type LoopRunState } from "./tools/loop/budget.js";
import { createLoopTools, loopWindow } from "./tools/loop/index.js";

/**
 * POST /api/v1/projects/:projectId/loop-runs/:runId — one Loop run's agent turn.
 *
 * The worker owns the run's lifecycle: it creates the system session, marks
 * the run `running`, calls this route, and writes the run's final status from
 * the answer. This route never touches `loop_runs.status` or the loop itself;
 * it runs one turn in the worker's session (persisted like any other turn, so
 * the transcript view opens it), attributed as loop_execution, and answers
 * with what the turn produced.
 *
 * Non-2xx answers are for requests that are refused (400/404/409); a turn
 * that started always answers 200 with its outcome in `status`.
 */
export const loopRunRoute = new Hono();

interface LoopRunRequest {
  sessionId: string;
  model?: string;
  providerName?: string;
  source?: ModelSource;
  deadlineMs: number;
}

/** The longest turn the route will run, whatever the caller asks. */
export const MAX_DEADLINE_MS = LOOP_LIMITS.runTimeoutMinutes * 60_000;

export const TIMED_OUT_ERROR = "The run's deadline passed before the agent finished.";

function parseRequest(body: unknown): LoopRunRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid JSON body";
  const { sessionId, model, providerName, source, deadlineMs } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return "sessionId must be a non-empty string";
  }
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return "deadlineMs must be a positive number";
  }
  for (const [name, value] of [
    ["model", model],
    ["providerName", providerName],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      return `${name} must be a string`;
    }
  }
  if (source !== undefined && source !== null && source !== "system" && source !== "byok") {
    return 'source must be "system" or "byok"';
  }
  return {
    sessionId,
    deadlineMs,
    model: typeof model === "string" && model ? model : undefined,
    providerName: typeof providerName === "string" && providerName ? providerName : undefined,
    source: (source ?? undefined) as ModelSource | undefined,
  };
}

/** The answer for a turn that never ran. */
function errorResult(error: unknown): LoopAgentResult {
  return {
    status: "error",
    summary: null,
    tracesRead: 0,
    toolCalls: 0,
    costUsd: null,
    error: publicErrorMessage(error),
    modelUsed: null,
    findings: [],
  };
}

/**
 * The model the agent was built with. A run that names none gets the agent
 * service's default, which only the built agent knows.
 */
export function modelUsed(
  agent: Pick<Agent, "state">,
  request: Pick<LoopRunRequest, "providerName" | "source">,
): LoopRunModel {
  const { id, provider } = agent.state.model;
  return {
    model: id,
    // A BYOK model's provider is its saved label, which the request names.
    provider: request.providerName ?? provider,
    source: request.source ?? ModelSource.SYSTEM,
  };
}

/** Which outcome a finished turn reports; a timeout wins, then a submitted summary. */
export function loopRunOutcome(input: {
  timedOut: boolean;
  state: LoopRunState;
  runError: string | null;
}): LoopAgentOutcome {
  if (input.timedOut) return "timed_out";
  if (input.state.summary !== null) return "submitted";
  if (input.runError !== null) return "error";
  if (input.state.budgetExhausted) return "budget_exhausted";
  return "no_summary";
}

function kickoffMessage(loopName: string, window: { start_after: string; end_before: string }) {
  return (
    `Run the loop ${JSON.stringify(loopName)} now over ${window.start_after} → ${window.end_before}. ` +
    "Follow the procedure, and finish with loop_submit_summary."
  );
}

loopRunRoute.post("/api/v1/projects/:projectId/loop-runs/:runId", async (c) => {
  const requestStart = Date.now();
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  // A Loop run is the platform's own work: only a system call may start one.
  const caller = callerIdentity(c, { allowSystem: true });
  if (!caller?.system) return c.json({ error: "a system call is required" }, 400);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const body = parseRequest(raw);
  if (typeof body === "string") return c.json({ error: body }, 400);

  const run = await prisma.loopRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      projectId: true,
      loopId: true,
      seq: true,
      trigger: true,
      status: true,
      sessionId: true,
      loop: {
        select: {
          name: true,
          detectorId: true,
          instructions: true,
          lookbackHours: true,
          dryRun: true,
        },
      },
    },
  });
  // A run of another project is as missing as no run at all.
  if (!run || run.projectId !== projectId) return c.json({ error: "loop run not found" }, 404);
  if (run.status !== "running") {
    return c.json({ error: `loop run is ${run.status}, not running` }, 409);
  }
  if (run.sessionId !== null && run.sessionId !== body.sessionId) {
    return c.json({ error: "sessionId is not this run's session" }, 400);
  }
  // The worker's system session in this project (getSession scopes a
  // user-less caller to system sessions of the named project).
  const session = await getSession(body.sessionId, "", projectId);
  if (!session) return c.json({ error: "session not found" }, 404);

  if (!claimRun(body.sessionId)) {
    return c.json({ error: "a run is already in progress for this session" }, 409);
  }

  let findingKeys: string[];
  try {
    findingKeys = await existingFindingKeys(prisma, projectId, run.loop.detectorId);
  } catch (error) {
    releaseRun(body.sessionId);
    console.error(`[Agent] Loop run ${runId} could not read its finding keys:`, error);
    return c.json(errorResult(error));
  }

  const now = new Date();
  const window = loopWindow({ lookbackHours: run.loop.lookbackHours, now });
  const maxNewFindingKeys = LOOP_LIMITS.newFindingKeysPerRun;
  const state = newLoopRunState();
  const attribution = { turnKind: "loop_execution" as const };
  let agent: Agent | undefined;
  const systemPrompt = getLoopSystemPrompt({
    projectId,
    loopName: run.loop.name,
    run: { seq: run.seq, trigger: run.trigger === "manual" ? "manual" : "schedule" },
    instructions: run.loop.instructions,
    lookbackHours: Math.round(
      (Date.parse(window.end_before) - Date.parse(window.start_after)) / 3_600_000,
    ),
    window,
    limits: { toolCalls: LOOP_LIMITS.toolCalls, traceReads: LOOP_LIMITS.traceReads },
    dryRun: run.loop.dryRun,
    maxNewFindingKeys,
    existingFindingKeys: findingKeys,
  });
  const message = kickoffMessage(run.loop.name, window);

  let sessionManager: SessionManager;
  let userRow: Awaited<ReturnType<SessionManager["appendMessage"]>>;
  try {
    const tools = createLoopTools({
      projectId,
      userId: "",
      loopId: run.loopId,
      runId: run.id,
      lookbackHours: run.loop.lookbackHours,
      now,
      state,
      // The model keeps calling past its cap: stop paying for calls that cannot run.
      onRunaway: () => agent?.abort(),
      existingFindingKeys: findingKeys,
      maxNewFindingKeys,
      dryRun: run.loop.dryRun,
    });
    ({ agent, sessionManager } = await getOrCreateAgent({
      sessionId: body.sessionId,
      projectId,
      workspaceId: session.workspaceId,
      userId: "",
      systemPrompt,
      tools,
      model: body.model,
      providerName: body.providerName,
      source: body.source,
    }));
    userRow = await sessionManager.appendMessage("user", message, attribution);
  } catch (error) {
    // The turn never started, so nothing else releases the claim.
    releaseRun(body.sessionId);
    removeAgent(body.sessionId);
    console.error(`[Agent] Loop run ${runId} could not start:`, error);
    return c.json(errorResult(error));
  }

  const trace: AgentTraceMeta = {
    traceId: turnTraceId(body.sessionId, userRow.id),
    projectId,
    kind: "loop",
    name: ROOT_SPAN_NAME,
    input: message,
    systemPrompt,
    metadata: { session_id: body.sessionId, loop_id: run.loopId, loop_run_id: run.id },
  };

  // The worker is the only client. When its request goes away (it timed out or
  // died), the turn stops: a reclaimed run must not overlap a turn still going.
  const request = c.req.raw.signal;
  const stopForCaller = () => agent?.abort();
  request.addEventListener("abort", stopForCaller, { once: true });

  // Nobody reads the events: the run's error and usage come back from
  // runAgentStream. An abort before the agent started had nothing to stop, so
  // the first event stops it.
  const stream: AgentRunStream = {
    writeSSE: () => {
      if (request.aborted) stopForCaller();
    },
    write: () => undefined,
    onAbort: (callback) => {
      if (request.aborted) void callback();
      else request.addEventListener("abort", () => void callback(), { once: true });
    },
  };

  let timedOut = false;
  const remaining = Math.max(
    0,
    Math.min(body.deadlineMs, MAX_DEADLINE_MS) - (Date.now() - requestStart),
  );
  const deadline = setTimeout(() => {
    timedOut = true;
    agent?.abort();
  }, remaining);

  let result: RunStreamResult;
  try {
    result = await runAgentStream(stream, {
      agent,
      message,
      sessionId: body.sessionId,
      // Nobody attends a Loop run: confirm-class calls (none are offered) fail closed.
      channelUserId: "",
      isByok: body.source === ModelSource.BYOK,
      sessionManager,
      attribution,
      trace,
    });
  } finally {
    clearTimeout(deadline);
    request.removeEventListener("abort", stopForCaller);
    // The agent closes over this run's tools, budget and state: drop it. A
    // later turn in the session rebuilds it from the persisted transcript.
    removeAgent(body.sessionId);
  }

  const runError = result.error;
  const status = loopRunOutcome({ timedOut, state, runError });
  return c.json({
    status,
    summary: state.summary,
    tracesRead: state.tracesRead,
    toolCalls: state.toolCalls,
    costUsd: result.usage?.cost ?? null,
    error: status === "timed_out" ? TIMED_OUT_ERROR : status === "error" ? runError : null,
    modelUsed: modelUsed(agent, body),
    // The one dry-run gate: a dry run's findings are checked but never handed to the worker.
    findings: run.loop.dryRun ? [] : [...state.findings.values()],
  } satisfies LoopAgentResult);
});
