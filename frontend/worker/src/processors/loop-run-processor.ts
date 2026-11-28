/**
 * Executes one Loop run: its start (every gate, under one lock), the check that
 * its window has traces, its model, then the agent service's loop-run route on
 * a fresh system session. The agent reads traces and answers with a summary and
 * its findings; this processor owns the run's lifecycle (loop_runs.status) from
 * pending to its end state. A run with findings is accepted by its finish:
 * succeeded with their keys, and the findings stored on the row, in one write
 * that lands only while the run is still this try's. They are then published
 * as hits of the Loop's hidden detector, which the signals round groups into
 * signals; a publish that does not complete is finished by the Loop tick (see
 * loops/publish.ts). A try that lost the run accepts nothing and publishes
 * nothing. A dry run's answer has none (the agent route drops them).
 */
import { Worker, type Job } from "bullmq";
import { prisma } from "@traceroot/core";
import { agentRequestHeaders } from "@traceroot/core/agent-service";
import { publicErrorMessage } from "@traceroot/core/public-error";
import {
  loopAgentResultSchema,
  type LoopAgentResult,
  type LoopFinding,
  type LoopRunModel,
} from "@traceroot/core/loops";
import { resolveProjectModel, type ResolvedModel } from "../agent/resolve-model.js";
import { finishLoopRun, type LoopRunFinish } from "../loops/finish.js";
import { PENDING_FINDINGS_KEY, pendingFindingsOf, publishLoopFindings } from "../loops/publish.js";
import { startLoopRun } from "../loops/start.js";
import { windowHasTraces } from "../loops/window-traces.js";
import {
  LOOP_AGENT_ABORT_SLACK_MS,
  loopRunConcurrency,
  loopRunTimeoutMs,
} from "../loops/config.js";
import {
  LOOP_RUN_QUEUE,
  createRedisConnection,
  type LoopRunJob,
} from "../queues/loop-run-queue.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";
/** The session create is one row write: a hung agent service must not hold the run's slot. */
export const LOOP_SESSION_TIMEOUT_MS = 30_000;
export const LOOP_SESSION_TIMEOUT_ERROR =
  "The agent service did not create the loop session in time.";

export const LOOP_NO_SUMMARY = "The run ended without a summary.";

export function noTracesSkip(lookbackHours: number): string {
  return `Skipped: no traces in the last ${lookbackHours} ${lookbackHours === 1 ? "hour" : "hours"}.`;
}

/**
 * Whether the run's window holds a trace. A failed check says yes: it only
 * spares the agent an empty window, and must never skip a run that had traces.
 */
async function hasTracesToRead(runId: string, projectId: string, lookbackHours: number) {
  try {
    return await windowHasTraces(projectId, lookbackHours);
  } catch (error) {
    console.error(`[Loops] run=${runId} could not check its window for traces:`, error);
    return true;
  }
}

function timeoutMessage(timeoutMs: number): string {
  return `The run did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`;
}

/** What a finished agent call means for the run. */
export function outcomeOf(result: LoopAgentResult, timeoutMs: number): LoopRunFinish {
  const summary = result.summary?.trim() ? result.summary : null;
  const usage = {
    summary,
    tracesRead: result.tracesRead ?? 0,
    costUsd: result.costUsd ?? null,
    metadata: { toolCalls: result.toolCalls ?? 0, agentStatus: result.status },
  };
  switch (result.status) {
    case "submitted":
    case "budget_exhausted":
      // Quiet, unless it has findings to accept (see processLoopRun).
      return summary
        ? { status: "quiet", ...usage }
        : { status: "failed", ...usage, error: LOOP_NO_SUMMARY };
    case "timed_out":
      return { status: "timed_out", ...usage, error: timeoutMessage(timeoutMs) };
    case "no_summary":
      return { status: "failed", ...usage, error: LOOP_NO_SUMMARY };
    default:
      return {
        status: "failed",
        ...usage,
        error: publicErrorMessage(result.error || "The agent failed to run this loop."),
      };
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function loadRun(runId: string) {
  return prisma.loopRun.findUnique({
    where: { id: runId },
    include: {
      loop: true,
      project: {
        select: {
          id: true,
          workspaceId: true,
          rcaModel: true,
          rcaProvider: true,
          rcaSource: true,
        },
      },
    },
  });
}

export async function processLoopRun(job: Pick<Job<LoopRunJob>, "data">): Promise<void> {
  const run = await loadRun(job.data.runId);
  if (!run || run.status !== "pending") return;
  // A skipped run was ended by its gate; a taken one is another worker's.
  if ((await startLoopRun(run)) !== "started") return;

  const { loop, project } = run;
  const running = {
    id: run.id,
    loopId: run.loopId,
    trigger: run.trigger,
    fromStatus: "running" as const,
    attempts: run.attempts,
  };
  const timeoutMs = loopRunTimeoutMs();
  let resolved: ResolvedModel | null = null;
  // What the agent says it ran on; it alone knows its default when we sent none.
  let ranOn: LoopRunModel | null = null;
  let finish: LoopRunFinish;
  // The findings the finish accepts.
  let findings: LoopFinding[] = [];
  try {
    if (!(await hasTracesToRead(run.id, project.id, loop.lookbackHours))) {
      // Nothing for the agent to read, checked before the model so that an
      // empty window always skips, whatever its model: no session, so it
      // counts against neither cap, and it leaves the failure streak alone.
      finish = { status: "skipped_no_traces", error: noTracesSkip(loop.lookbackHours) };
    } else {
      // The Loop's own model, else the project's Agent model.
      const choice = loop.model
        ? { model: loop.model, provider: loop.provider, source: loop.source }
        : { model: project.rcaModel, provider: project.rcaProvider, source: project.rcaSource };
      const model = await resolveProjectModel(
        choice.model,
        choice.provider,
        choice.source,
        project.workspaceId,
      );
      if (model && "error" in model) {
        // Failed where the user sees it, and on the failure streak, but the
        // agent was never called: no session, so it counts against neither cap.
        finish = { status: "failed", error: model.error };
      } else {
        resolved = model;
        const result = await callAgent({
          runId: run.id,
          projectId: project.id,
          workspaceId: project.workspaceId,
          title: `[Loop] ${loop.name} #${run.seq}`,
          resolved,
          timeoutMs,
        });
        ranOn = result.modelUsed;
        finish = outcomeOf(result, timeoutMs);
        if (finish.status === "quiet") findings = result.findings;
      }
    }
  } catch (error) {
    if (isAbort(error)) {
      finish = { status: "timed_out", error: timeoutMessage(timeoutMs) };
    } else {
      console.error(`[Loops] run=${run.id} failed:`, error);
      finish = { status: "failed", error: publicErrorMessage(error) };
    }
  }
  const model: LoopRunModel | null =
    ranOn ??
    (resolved && {
      model: resolved.model,
      provider: resolved.providerName,
      source: resolved.source,
    });
  const withModel = (outcome: LoopRunFinish): LoopRunFinish => ({
    ...outcome,
    metadata: {
      model: model?.model ?? null,
      provider: model?.provider ?? null,
      source: model?.source ?? null,
      ...outcome.metadata,
    },
  });
  if (findings.length === 0) {
    await finishLoopRun(running, withModel(finish));
    return;
  }

  // Accepted in the finish's one write: a try that outlived its reclaim, or
  // whose run already finished, accepts nothing and so publishes nothing.
  const now = new Date();
  const pending = pendingFindingsOf(findings, now.getTime());
  const accepted = await finishLoopRun(
    running,
    withModel({
      ...finish,
      status: "succeeded",
      findingKeys: pending.findings.map((f) => f.key),
      metadata: { ...finish.metadata, [PENDING_FINDINGS_KEY]: pending },
    }),
    now,
  );
  if (!accepted) {
    console.log(
      `[Loops] run=${run.id} attempt ${run.attempts} is stale; its findings are not accepted.`,
    );
    return;
  }
  // The tick republishes whatever this leaves pending.
  await publishLoopFindings(run.id, pending.tries).catch((error: unknown) =>
    console.error(`[Loops] run=${run.id} could not publish its findings:`, error),
  );
}

async function callAgent(params: {
  runId: string;
  projectId: string;
  workspaceId: string;
  title: string;
  resolved: ResolvedModel | null;
  timeoutMs: number;
}): Promise<LoopAgentResult> {
  const headers = {
    "Content-Type": "application/json",
    // a system call, not a user's: the session's userId is stored as null
    ...agentRequestHeaders({ workspaceId: params.workspaceId, system: true }),
  };

  // Created first, as runRcaSession does, so the run links to its chat even
  // when the run itself fails.
  let sessionRes: Response;
  try {
    sessionRes = await fetch(`${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: params.title }),
      signal: AbortSignal.timeout(LOOP_SESSION_TIMEOUT_MS),
    });
  } catch (error) {
    // A failed run, not a timed-out one: the agent never started on it.
    if (isAbort(error)) throw new Error(LOOP_SESSION_TIMEOUT_ERROR);
    throw error;
  }
  if (!sessionRes.ok) {
    throw new Error(`Failed to create the loop session: HTTP ${sessionRes.status}`);
  }
  const session = (await sessionRes.json()) as { id: string };
  await prisma.loopRun.update({ where: { id: params.runId }, data: { sessionId: session.id } });

  const res = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/loop-runs/${params.runId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        ...(params.resolved && {
          model: params.resolved.model,
          providerName: params.resolved.providerName,
          source: params.resolved.source,
        }),
        deadlineMs: params.timeoutMs,
      }),
      signal: AbortSignal.timeout(params.timeoutMs + LOOP_AGENT_ABORT_SLACK_MS),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[Loops] run=${params.runId} agent HTTP ${res.status}: ${body.slice(0, 500)}`);
    throw new Error(`The agent service failed to run this loop (HTTP ${res.status}).`);
  }
  const parsed = loopAgentResultSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error(`[Loops] run=${params.runId} unreadable agent answer:`, parsed.error.issues);
    throw new Error("The agent service answered with a result this worker cannot read.");
  }
  return parsed.data;
}

export function startLoopRunWorker(): Worker<LoopRunJob> {
  const worker = new Worker<LoopRunJob>(LOOP_RUN_QUEUE, processLoopRun, {
    connection: createRedisConnection(),
    concurrency: loopRunConcurrency(),
  });
  worker.on("failed", (job, err) => {
    console.error(`[Loops] Job ${job?.id} failed:`, err.message);
  });
  return worker;
}
