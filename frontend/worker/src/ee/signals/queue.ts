import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { prisma } from "@traceroot/core";
import { SIGNAL_ASSIGN_QUEUE, signalAssignJobId } from "@traceroot/core/signals";
import { createRedisConnection } from "../../queues/detector-run-queue.js";
import {
  ASSIGN_DELAY_MS,
  DRAIN_MARGIN_MS,
  SWEEP_BATCH,
  SWEEP_STALE_MS,
  WAITING_LOOKBACK_MS,
  signalsAvailable,
} from "./config.js";

/** An assignment job names its partition; the sweeper job carries no partition. */
export type SignalAssignJobData = { projectId: string; detectorId: string } | { sweep: true };

export const ASSIGN_JOB_NAME = "assign";
export const SWEEP_JOB_NAME = "sweep";

let queue: Queue<SignalAssignJobData> | null = null;
export function getSignalAssignQueue(): Queue<SignalAssignJobData> {
  if (!queue) {
    queue = new Queue<SignalAssignJobData>(SIGNAL_ASSIGN_QUEUE, {
      connection: createRedisConnection(),
    });
  }
  return queue;
}

/** Redis set of "projectId:detectorId" whose pending mark is still to be written. */
const UNMARKED_KEY = "signals:assign:unmarked";

let bookkeeping: Redis | null = null;
function redis(): Redis {
  bookkeeping ??= createRedisConnection();
  return bookkeeping;
}

/**
 * Enqueue the partition's assignment job. The fixed job id makes this a no-op
 * while the partition's job is waiting, delayed or running, so a partition has
 * at most one job. Finished and failed jobs are removed at once: a kept job
 * would swallow every later add under the same id. The enqueue time is recorded
 * in Postgres first (detectors.assignment_pending_at), so an add that fails or
 * is lost, Redis outage included, is still found by the sweeper. If Postgres
 * does not take the mark, the partition is kept in Redis instead (UNMARKED_KEY)
 * and the job is still added; the sweeper writes the mark later. The error is
 * thrown either way, and with neither store there is no record at all.
 */
export async function enqueueAssignment(
  projectId: string,
  detectorId: string,
  delayMs: number = ASSIGN_DELAY_MS,
): Promise<void> {
  const jobId = signalAssignJobId(projectId, detectorId);
  // Raw SQL: a client update would also advance the detector's updateTime,
  // which the detector list shows as its last edit.
  let markError: unknown = null;
  try {
    await prisma.$executeRaw`
      UPDATE detectors SET assignment_pending_at = ${new Date()}
      WHERE id = ${detectorId} AND project_id = ${projectId}`;
  } catch (err) {
    await redis().sadd(UNMARKED_KEY, `${projectId}:${detectorId}`);
    markError = err;
  }
  await getSignalAssignQueue().add(
    ASSIGN_JOB_NAME,
    { projectId, detectorId },
    {
      jobId,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    },
  );
  if (markError) throw markError;
}

/**
 * Write the pending mark of each partition whose mark Postgres did not take
 * (see enqueueAssignment), and enqueue it. A partition is forgotten only once
 * its mark is written; a failure leaves it and the rest for the next sweep.
 *
 * @returns the number of partitions marked
 */
export async function remarkUnmarked(): Promise<number> {
  const members = await redis().smembers(UNMARKED_KEY);
  for (const member of members) {
    // Neither id contains a colon: signalAssignJobId rejects one.
    const [projectId, detectorId] = member.split(":");
    await enqueueAssignment(projectId, detectorId, 0);
    await redis().srem(UNMARKED_KEY, member);
  }
  return members.length;
}

/**
 * The detector worker's call site, after the finding and its runs are written
 * to ClickHouse: enqueue the assignment job of each triggered detector with
 * signals on. The job reads the hits back from ClickHouse, so nothing else is
 * passed. Nothing is enqueued when the deployment has no key for signals.
 *
 * @returns the number of partitions enqueued
 */
export async function enqueueSignalHits(params: {
  projectId: string;
  detectors: readonly { id: string; enableSignals: boolean }[];
  triggered: readonly { detectorId: string }[];
}): Promise<number> {
  if (!signalsAvailable()) return 0;
  const on = new Set(params.detectors.filter((d) => d.enableSignals).map((d) => d.id));
  const partitions = [...new Set(params.triggered.map((t) => t.detectorId))].filter((id) =>
    on.has(id),
  );
  // Every partition is tried even if one fails; the failure is still reported.
  const results = await Promise.allSettled(
    partitions.map((detectorId) => enqueueAssignment(params.projectId, detectorId)),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return partitions.length;
}

/**
 * Record that the partition's job read no waiting hits at `readAtMs`: clear its
 * pending mark, unless the mark was written after that read (less a margin for
 * clock skew between workers), when hits may have arrived after the read.
 */
export async function markDrained(
  projectId: string,
  detectorId: string,
  readAtMs: number,
): Promise<void> {
  // Raw SQL, as in enqueueAssignment, so the detector's updateTime stays put.
  await prisma.$executeRaw`
    UPDATE detectors SET assignment_pending_at = NULL
    WHERE id = ${detectorId} AND project_id = ${projectId}
      AND assignment_pending_at <= ${new Date(readAtMs - DRAIN_MARGIN_MS)}`;
}

/**
 * Partitions whose job may have been lost or never enqueued: marked pending
 * more than SWEEP_STALE_MS ago and not drained since, oldest first. Re-enqueuing
 * one refreshes its mark, so a batch limit never starves the rest.
 */
export async function partitionsToSweep(
  now: number = Date.now(),
): Promise<{ projectId: string; detectorId: string }[]> {
  const rows = await prisma.detector.findMany({
    where: { assignmentPendingAt: { lt: new Date(now - SWEEP_STALE_MS) } },
    select: { id: true, projectId: true },
    orderBy: { assignmentPendingAt: "asc" },
    take: SWEEP_BATCH,
  });
  return rows.map((r) => ({ projectId: r.projectId, detectorId: r.id }));
}

/**
 * Count one more failure of a hit, keeping the time of its first failure. The
 * record expires with the lookback, after which the hit is no longer read.
 */
export async function recordHitFailure(
  runId: string,
  now: number,
): Promise<{ count: number; firstAt: number }> {
  const key = `signals:assign:failures:${runId}`;
  const r = redis();
  const count = await r.hincrby(key, "count", 1);
  await r.hsetnx(key, "first", String(now));
  await r.pexpire(key, WAITING_LOOKBACK_MS);
  const first = await r.hget(key, "first");
  return { count, firstAt: Number(first ?? now) };
}

/** Forget a hit's failures (it was given up), so a replay of it starts over. */
export async function clearHitFailures(runId: string): Promise<void> {
  await redis().del(`signals:assign:failures:${runId}`);
}
