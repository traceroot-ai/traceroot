import type { PrismaClient, Prisma } from "@traceroot/core";
import {
  computeUpdateFacts,
  type UpdateWindows,
  type UpdateFacts,
  type WindowAggregates,
} from "@traceroot/core/updates";
import { buildSignalsRollup, type SignalsRollup } from "./signals-rollup.js";

/** A run still "running" this long after it started belongs to a worker that is gone. */
export const STALE_RUNNING_MS = 15 * 60_000;

export type ExecuteDb = Pick<
  PrismaClient,
  "projectUpdateRun" | "project" | "signal" | "signalHit" | "signalStatusEvent"
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
      select: { id: true },
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
    const facts = computeUpdateFacts(current, previous);
    const signalsRollup = await buildSignalsRollup(db, run.projectId, run, deps.appBaseUrl);

    await db.projectUpdateRun.update({
      where: { id: runId },
      data: {
        status: "succeeded",
        finishedAt: now(),
        facts: facts as unknown as Prisma.InputJsonValue,
        signalsRollup: signalsRollup as unknown as Prisma.InputJsonValue,
      },
    });
    return { status: "succeeded", facts, signalsRollup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.projectUpdateRun.update({
      where: { id: runId },
      data: { status: "failed", finishedAt: now(), error: message.slice(0, 1000) },
    });
    return { status: "failed", error: message };
  }
}
