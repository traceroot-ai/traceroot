/**
 * The writes that end a Loop run: the run row, the Loop's lastRunAt, and the
 * failure streak that pauses a Loop whose scheduled runs keep failing.
 */
import { prisma, type Prisma } from "@traceroot/core";
import { LOOP_LIMITS, type LoopRunStatus } from "@traceroot/core/loops";

/**
 * A run's end state. The gates' skips are written by startLoopRun; an empty
 * window's skip is written here, after the run started.
 */
export type LoopRunOutcome = Extract<
  LoopRunStatus,
  "quiet" | "failed" | "timed_out" | "skipped_no_traces"
>;

export interface LoopRunFinish {
  status: LoopRunOutcome;
  summary?: string | null;
  error?: string | null;
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

/**
 * Finish a run once: the update only lands while the run still has
 * `fromStatus` and is on the same try, so a reclaim and a late worker cannot
 * both finish it. Returns false when someone else already did.
 */
export async function finishLoopRun(
  run: FinishTarget,
  finish: LoopRunFinish,
  now: Date = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const metadata =
      finish.metadata === undefined
        ? undefined
        : ({
            ...((run.metadata as Record<string, unknown> | null) ?? {}),
            ...finish.metadata,
          } as Prisma.InputJsonObject);
    const written = await tx.loopRun.updateMany({
      where: { id: run.id, status: run.fromStatus, attempts: run.attempts },
      data: {
        status: finish.status,
        finishedAt: now,
        summary: finish.summary ?? null,
        error: finish.error ?? null,
        // A run records no findings.
        findingKeys: [],
        ...(finish.tracesRead !== undefined && { tracesRead: finish.tracesRead }),
        ...(finish.costUsd !== undefined && { costUsd: finish.costUsd }),
        ...(metadata !== undefined && { metadata }),
      },
    });
    if (written.count === 0) return false;

    // A skipped run did not run: the Loop's lastRunAt and streak stay as they were.
    if (finish.status !== "skipped_no_traces") await settleLoop(tx, run, finish.status, now);
    return true;
  });
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
