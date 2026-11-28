/**
 * The writes that end a Loop run: the run row, the Loop's lastRunAt, and the
 * failure streak that pauses a Loop whose scheduled runs keep failing. A run
 * whose outcome depends on recording its findings finishes under a lock on its
 * row, so the findings are recorded only by the try that still owns the run.
 */
import { prisma, type Prisma } from "@traceroot/core";
import { LOOP_LIMITS, type LoopRunStatus } from "@traceroot/core/loops";

/**
 * A run's end state. The gates' skips are written by startLoopRun; an empty
 * window's skip is written here, after the run started.
 */
export type LoopRunOutcome = Extract<
  LoopRunStatus,
  "succeeded" | "quiet" | "failed" | "timed_out" | "skipped_no_traces"
>;

export interface LoopRunFinish {
  status: LoopRunOutcome;
  summary?: string | null;
  error?: string | null;
  /** The finding keys the run recorded, each once; set only when it succeeded. */
  findingKeys?: string[];
  tracesRead?: number;
  costUsd?: number | null;
  /** Merged into the run's metadata. */
  metadata?: Record<string, unknown>;
}

interface FinishTarget {
  id: string;
  loopId: string;
  trigger: string;
  /** The status the run must still have for this write to land. */
  fromStatus: LoopRunStatus;
  /**
   * The try this write belongs to: a reclaim bumps it, so a first try that
   * outlives its reclaim cannot finish the retry's run.
   */
  attempts: number;
  metadata?: Prisma.JsonValue | null;
}

/** The run is still this try's: it has `fromStatus` and was not reclaimed since. */
function ownedBy(run: Pick<FinishTarget, "id" | "fromStatus" | "attempts">) {
  return { id: run.id, status: run.fromStatus, attempts: run.attempts };
}

/**
 * Finish a run once: the update only lands while the run is still this try's
 * (see ownedBy), so a reclaim and a late worker cannot both finish it. Returns
 * false when someone else already did.
 */
export async function finishLoopRun(
  run: FinishTarget,
  finish: LoopRunFinish,
  now: Date = new Date(),
): Promise<boolean> {
  return prisma.$transaction((tx) => writeFinish(tx, run, finish, now));
}

/**
 * How long the locked step may hold the run row. Recording writes at most
 * findingsPerRun x tracesPerFinding hits, ten at a time, each two short internal
 * writes, then one enqueue: about twenty writes in a row, a few seconds in all.
 * A minute leaves room for a slow backend, and still bounds how long a reclaim
 * of this run can wait on the lock.
 */
export const LOCKED_FINISH_TIMEOUT_MS = 60_000;
/** How long the locked step may wait for a database connection to start. */
export const LOCKED_FINISH_MAX_WAIT_MS = 10_000;

/**
 * Do `work` and write the outcome it returns as one step: the run row is
 * locked while it is still this try's, so a reclaim's update waits until the
 * outcome is written and then finds the run finished. `work` must not throw:
 * it turns its own failures into an outcome. Returns false, without calling
 * `work`, when the run is no longer this try's.
 */
export async function finishLoopRunLocked(
  run: FinishTarget,
  work: () => Promise<LoopRunFinish>,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM loop_runs
        WHERE id = ${run.id} AND status = ${run.fromStatus} AND attempts = ${run.attempts}
        FOR UPDATE`;
      if (owned.length === 0) return false;
      const finish = await work();
      return writeFinish(tx, run, finish, now());
    },
    { timeout: LOCKED_FINISH_TIMEOUT_MS, maxWait: LOCKED_FINISH_MAX_WAIT_MS },
  );
}

/** The run's outcome and the Loop's settle, on the caller's transaction. */
async function writeFinish(
  tx: Prisma.TransactionClient,
  run: FinishTarget,
  finish: LoopRunFinish,
  now: Date,
): Promise<boolean> {
  const metadata =
    finish.metadata === undefined
      ? undefined
      : ({
          ...((run.metadata as Record<string, unknown> | null) ?? {}),
          ...finish.metadata,
        } as Prisma.InputJsonObject);
  const written = await tx.loopRun.updateMany({
    where: ownedBy(run),
    data: {
      status: finish.status,
      finishedAt: now,
      summary: finish.summary ?? null,
      error: finish.error ?? null,
      findingKeys: finish.findingKeys ?? [],
      ...(finish.tracesRead !== undefined && { tracesRead: finish.tracesRead }),
      ...(finish.costUsd !== undefined && { costUsd: finish.costUsd }),
      ...(metadata !== undefined && { metadata }),
    },
  });
  if (written.count === 0) return false;

  // A skipped run did not run: the Loop's lastRunAt and streak stay as they were.
  if (finish.status !== "skipped_no_traces") await settleLoop(tx, run, finish.status, now);
  return true;
}

/**
 * lastRunAt, and the failure streak. Only scheduled runs move the streak: a
 * manual run is someone trying the Loop out and says nothing about its schedule.
 */
async function settleLoop(
  tx: Prisma.TransactionClient,
  run: FinishTarget,
  status: LoopRunOutcome,
  now: Date,
): Promise<void> {
  const counts = run.trigger === "schedule";
  const failed = status === "failed" || status === "timed_out";
  const loop = await tx.loop.update({
    where: { id: run.loopId },
    data: {
      lastRunAt: now,
      ...(counts && (failed ? { failureStreak: { increment: 1 } } : { failureStreak: 0 })),
    },
    select: { status: true, failureStreak: true },
  });
  if (
    counts &&
    failed &&
    loop.status === "active" &&
    loop.failureStreak >= LOOP_LIMITS.failureStreakToPause
  ) {
    await tx.loop.update({
      where: { id: run.loopId },
      data: { status: "paused_by_system" },
    });
  }
}
