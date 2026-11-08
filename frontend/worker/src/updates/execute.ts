import type { PrismaClient, Prisma } from "@traceroot/core";
import {
  computeUpdateFacts,
  type UpdateWindows,
  type UpdateFacts,
  type WindowAggregates,
} from "@traceroot/core/updates";
import { buildSignalsRollup, type SignalsRollup } from "./signals-rollup.js";
import { runAgentStage, type AgentStageDeps } from "./stage.js";

/** A run still "running" this long after it started belongs to a worker that is gone. */
export const STALE_RUNNING_MS = 15 * 60_000;

export type ExecuteDb = Pick<
  PrismaClient,
  | "projectUpdateRun"
  | "projectUpdateSchedule"
  | "project"
  | "signal"
  | "signalHit"
  | "signalStatusEvent"
>;

export interface ExecuteDeps {
  db: ExecuteDb;
  readAggregates: (
    projectId: string,
    windows: Pick<UpdateWindows, "windowStart" | "windowEnd" | "prevWindowStart" | "prevWindowEnd">,
    timezone: string,
  ) => Promise<{ current: WindowAggregates; previous: WindowAggregates }>;
  appBaseUrl: string;
  now?: () => Date;
  /** The agent and delivery. Without it a run stops after the numbers. */
  agent?: AgentStageDeps;
}

export interface ExecuteOutcome {
  status: "succeeded" | "failed" | "stopped" | "skipped";
  facts?: UpdateFacts;
  signalsRollup?: SignalsRollup;
  error?: string;
}

/**
 * Compute the numbers of one run and keep them on the run row. A run is
 * claimed first, so a job delivered twice cannot compute twice, and a run that
 * already finished is left alone. Later stages (the agent, delivery) build on
 * the facts stored here.
 */
export async function executeRun(deps: ExecuteDeps, runId: string): Promise<ExecuteOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // Claimable: waiting, failed (a retry), or left "running" by a worker that died.
  const staleBefore = new Date(now().getTime() - STALE_RUNNING_MS);
  const claim = await db.projectUpdateRun.updateMany({
    where: {
      id: runId,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "running", startedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "running", startedAt: now(), error: null, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return { status: "skipped" };

  const run = await db.projectUpdateRun.findUniqueOrThrow({ where: { id: runId } });
  try {
    const project = await db.project.findFirst({
      where: { id: run.projectId, deleteTime: null },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        rcaSource: true,
        rcaProvider: true,
        rcaModel: true,
      },
    });
    if (!project) {
      // Not retryable: the project is gone, so the run is over.
      await db.projectUpdateRun.update({
        where: { id: runId },
        data: { status: "stopped", finishedAt: now(), error: "project not found" },
      });
      return { status: "stopped", error: "project not found" };
    }

    const { current, previous } = await deps.readAggregates(run.projectId, run, run.timezone);
    const facts = { ...computeUpdateFacts(current, previous), timezone: run.timezone };
    const signalsRollup = await buildSignalsRollup(db, run.projectId, run, deps.appBaseUrl);

    const stored = {
      facts: facts as unknown as Prisma.InputJsonValue,
      signalsRollup: signalsRollup as unknown as Prisma.InputJsonValue,
    };
    if (!deps.agent) {
      await db.projectUpdateRun.update({
        where: { id: runId },
        data: { status: "succeeded", finishedAt: now(), ...stored },
      });
      return { status: "succeeded", facts, signalsRollup };
    }

    await db.projectUpdateRun.update({ where: { id: runId }, data: stored });
    const fresh = await db.projectUpdateRun.findUniqueOrThrow({ where: { id: runId } });
    const outcome = await runAgentStage(
      { ...deps.agent, db, appBaseUrl: deps.appBaseUrl, now },
      fresh,
      project,
      facts,
      signalsRollup,
      run.frequency as "daily" | "weekly",
    );
    if (outcome.status === "succeeded") {
      await db.projectUpdateRun.update({
        where: { id: runId },
        data: { status: "succeeded", finishedAt: now(), deliveryNote: outcome.note },
      });
      return { status: "succeeded", facts, signalsRollup };
    }
    if (outcome.status === "stopped") {
      await db.projectUpdateRun.update({
        where: { id: runId },
        data: {
          status: "stopped",
          finishedAt: now(),
          stopReason: outcome.stopReason,
          error: outcome.message,
        },
      });
      return { status: "stopped", facts, signalsRollup, error: outcome.message };
    }
    throw new Error(outcome.error);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.projectUpdateRun.update({
      where: { id: runId },
      data: { status: "failed", finishedAt: now(), error: message.slice(0, 1000) },
    });
    return { status: "failed", error: message };
  }
}
