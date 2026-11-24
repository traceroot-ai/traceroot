/**
 * Executes one Loop run: its start (every gate, under one lock), its model,
 * then the agent service's loop-run route on a fresh system session. The agent
 * reads traces and answers with a summary; this processor owns the run's
 * lifecycle (loop_runs.status) from pending to its end state. A run records its summary and memory notes; no finding or signal.
 */
import { Worker, type Job } from "bullmq";
import { prisma } from "@traceroot/core";
import { agentRequestHeaders } from "@traceroot/core/agent-service";
import { publicErrorMessage } from "@traceroot/core/public-error";
import type { LoopAgentResult, LoopRunModel } from "@traceroot/core/loops";
import { resolveProjectModel, type ResolvedModel } from "../agent/resolve-model.js";
import { finishLoopRun, type LoopRunFinish } from "../loops/finish.js";
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
      // A run records no findings, so one that produced its summary is quiet.
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
  };
  const timeoutMs = loopRunTimeoutMs();
  let resolved: ResolvedModel | null = null;
  // What the agent says it ran on; it alone knows its default when we sent none.
  let ranOn: LoopRunModel | null = null;
  let finish: LoopRunFinish;
  try {
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
      // Failed where the user sees it, and on the failure streak, but the agent
      // was never called: no session, so it counts against neither cap.
      finish = { status: "failed", error: model.error };
    } else if (!(await hasTracesToRead(run.id, project.id, loop.lookbackHours))) {
      // Nothing for the agent to read: no session, so it counts against
      // neither cap, and it leaves the failure streak alone.
      finish = { status: "skipped_no_traces", error: noTracesSkip(loop.lookbackHours) };
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
  await finishLoopRun(running, {
    ...finish,
    metadata: {
      model: model?.model ?? null,
      provider: model?.provider ?? null,
      source: model?.source ?? null,
      ...finish.metadata,
    },
  });
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
  const sessionRes = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/sessions`,
    { method: "POST", headers, body: JSON.stringify({ title: params.title }) },
  );
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
  return (await res.json()) as LoopAgentResult;
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
