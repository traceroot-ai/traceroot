/**
 * The Loop tick: claim due Loops into scheduled runs, enqueue every pending run,
 * and reclaim runs left "running" by a worker that died. Started from
 * detector-main.ts on the same cron tick as the alert scheduler (one tick at a time).
 * Every step is safe to run from two ticks or replicas at once.
 */
import type { Queue } from "bullmq";
import { prisma, Prisma } from "@traceroot/core";
import { createRun, hasActiveRun, nextRunAt, scheduleFromColumns } from "@traceroot/core/loops";
import { finishLoopRun } from "./finish.js";
import { startCronTick, type CronTickHandle } from "../scheduling/cron-tick.js";
import {
  LOOP_RECLAIM_GRACE_MS,
  LOOP_RUN_MAX_ATTEMPTS,
  isLoopSchedulerEnabled,
  loopRunTimeoutMs,
  loopTickCron,
} from "./config.js";
import {
  createLoopRunQueue,
  createRedisConnection,
  enqueueLoopRun,
  type LoopQueue,
  type LoopRunJob,
} from "../queues/loop-run-queue.js";

const log = (message: string) => console.log(`[Loops] ${message}`);
const logError = (message: string, error?: unknown) =>
  console.error(`[Loops] ${message}`, ...(error === undefined ? [] : [error]));

/** Bounds one tick's reads; anything past it waits for the next tick. */
const TICK_BATCH = 500;

export const WORKER_STOPPED_ERROR = "The worker running this loop stopped.";

let queue: Queue<LoopRunJob> | undefined;
function getLoopRunQueue(): Queue<LoopRunJob> {
  queue ??= createLoopRunQueue(createRedisConnection({ maxRetriesPerRequest: 3 }));
  return queue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * The slot after the claimed one. Counting from the slot keeps an interval from
 * drifting by the tick's lateness; a worker that was down across several slots
 * runs the claimed one only and then counts from now, so it never catches up
 * on the slots it missed.
 */
export function slotAfter(
  schedule: ReturnType<typeof scheduleFromColumns>,
  slot: Date,
  now: Date,
): Date {
  const next = nextRunAt(schedule, slot);
  return next > now ? next : nextRunAt(schedule, now);
}

/**
 * Turn every due Loop into a scheduled run. Each Loop is claimed with a
 * compare-and-set on the nextRunAt this tick read, so of two ticks only one
 * advances it and creates the run; the unique (loopId, slotAt) index is the
 * backstop. A Loop that already has a run going has its slot advanced but gets
 * no second run. Returns the ids of the runs created.
 */
export async function claimDueLoops(now: Date): Promise<string[]> {
  const due = await prisma.loop.findMany({
    where: { status: "active", nextRunAt: { lte: now } },
    select: {
      id: true,
      projectId: true,
      nextRunAt: true,
      scheduleKind: true,
      intervalHours: true,
      weekday: true,
      hour: true,
      timezone: true,
    },
    orderBy: { nextRunAt: "asc" },
    take: TICK_BATCH,
  });

  const created: string[] = [];
  for (const loop of due) {
    const slot = loop.nextRunAt!;
    try {
      const next = slotAfter(scheduleFromColumns(loop), slot, now);
      const runId = await prisma.$transaction(async (tx) => {
        const claimed = await tx.loop.updateMany({
          where: { id: loop.id, status: "active", nextRunAt: slot },
          data: { nextRunAt: next },
        });
        if (claimed.count === 0) return null; // another tick won this slot
        if (await hasActiveRun(tx, loop.id)) {
          log(`loop=${loop.id} slot=${slot.toISOString()} skipped: a run is still going`);
          return null;
        }
        const run = await createRun(tx, {
          loopId: loop.id,
          projectId: loop.projectId,
          trigger: "schedule",
          slotAt: slot,
        });
        return run.id;
      });
      if (runId !== null) created.push(runId);
    } catch (error) {
      if (isUniqueViolation(error)) continue; // the slot already has its run
      logError(`claim failed loop=${loop.id}`, error);
    }
  }
  return created;
}

/**
 * Enqueue every pending run, scheduled or manual. The job id is the run's, so
 * a run already queued is not queued twice.
 */
export async function enqueuePendingRuns(target: LoopQueue): Promise<number> {
  const pending = await prisma.loopRun.findMany({
    where: { status: "pending" },
    select: { id: true },
    orderBy: { createTime: "asc" },
    take: TICK_BATCH,
  });
  let enqueued = 0;
  for (const run of pending) {
    try {
      await enqueueLoopRun(target, run.id);
      enqueued += 1;
    } catch (error) {
      logError(`enqueue failed run=${run.id}`, error);
    }
  }
  return enqueued;
}

/**
 * A run still "running" well past its timeout belongs to a worker that died
 * (the agent call itself is aborted shortly after the deadline). It goes back to
 * pending for one more try, and after that it fails.
 */
export async function reclaimStaleRuns(
  now: Date,
  target: LoopQueue,
  timeoutMs: number = loopRunTimeoutMs(),
): Promise<{ retried: number; failed: number }> {
  const cutoff = new Date(now.getTime() - timeoutMs - LOOP_RECLAIM_GRACE_MS);
  const stale = await prisma.loopRun.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, loopId: true, trigger: true, attempts: true, startedAt: true },
    take: TICK_BATCH,
  });

  let retried = 0;
  let failed = 0;
  for (const run of stale) {
    try {
      if (run.attempts < LOOP_RUN_MAX_ATTEMPTS) {
        const reset = await prisma.loopRun.updateMany({
          where: { id: run.id, status: "running", startedAt: run.startedAt },
          data: { status: "pending", attempts: run.attempts + 1, startedAt: null },
        });
        if (reset.count === 0) continue;
        retried += 1;
        log(`reclaimed run=${run.id} attempt=${run.attempts + 1}`);
        await enqueueLoopRun(target, run.id);
      } else {
        const finished = await finishLoopRun(
          { ...run, fromStatus: "running" },
          { status: "failed", error: WORKER_STOPPED_ERROR },
          now,
        );
        if (finished) {
          failed += 1;
          log(`run=${run.id} failed after ${run.attempts} attempts`);
        }
      }
    } catch (error) {
      logError(`reclaim failed run=${run.id}`, error);
    }
  }
  return { retried, failed };
}

/** One tick. Each step is guarded so a failing one does not stop the others. */
export async function runLoopTick(now: Date, target: LoopQueue = getLoopRunQueue()): Promise<void> {
  try {
    const created = await claimDueLoops(now);
    if (created.length > 0) log(`claimed ${created.length} scheduled run(s)`);
  } catch (error) {
    logError("claim read failed", error);
  }
  try {
    await reclaimStaleRuns(now, target);
  } catch (error) {
    logError("reclaim read failed", error);
  }
  try {
    await enqueuePendingRuns(target);
  } catch (error) {
    logError("pending read failed", error);
  }
}

export function startLoopScheduler(): CronTickHandle | undefined {
  if (!isLoopSchedulerEnabled()) {
    log('scheduler disabled (set LOOP_SCHEDULER_ENABLED="true" to run it)');
    return undefined;
  }
  return startCronTick({
    label: "Loops",
    expression: loopTickCron(),
    tick: (now) => runLoopTick(now),
  });
}

/** Close the producer connection on shutdown. */
export async function closeLoopRunQueue(): Promise<void> {
  if (queue) await queue.close();
  queue = undefined;
}
