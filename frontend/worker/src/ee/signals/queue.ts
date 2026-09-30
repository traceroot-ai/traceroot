import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { SIGNAL_ASSIGN_QUEUE, signalAssignJobId } from "@traceroot/core/signals";
import { createRedisConnection } from "../../queues/detector-run-queue.js";
import {
  ASSIGN_DELAY_MS,
  DRAIN_MARGIN_MS,
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

/**
 * The sweeper's records, two Redis sorted sets keyed by "project:detector": when
 * a partition was last enqueued, and when its job last read no waiting hits.
 * Ids never contain ":" (signalAssignJobId rejects them), so the key splits back.
 */
const ENQUEUED_KEY = "signals:assign:enqueued";
const DRAINED_KEY = "signals:assign:drained";

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
 * first, so an add that is lost (or swallowed by a job that is just finishing)
 * is still seen by the sweeper.
 */
export async function enqueueAssignment(
  projectId: string,
  detectorId: string,
  delayMs: number = ASSIGN_DELAY_MS,
): Promise<void> {
  const jobId = signalAssignJobId(projectId, detectorId);
  await redis().zadd(ENQUEUED_KEY, Date.now(), `${projectId}:${detectorId}`);
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

/** Record that the partition's job read no waiting hits at `readAtMs`. */
export async function markDrained(
  projectId: string,
  detectorId: string,
  readAtMs: number,
): Promise<void> {
  await redis().zadd(DRAINED_KEY, readAtMs, `${projectId}:${detectorId}`);
}

/**
 * Partitions whose job may have been lost: enqueued more than SWEEP_STALE_MS
 * ago and not drained since. Records older than the lookback are dropped first.
 */
export async function partitionsToSweep(
  now: number = Date.now(),
): Promise<{ projectId: string; detectorId: string }[]> {
  const r = redis();
  await r.zremrangebyscore(ENQUEUED_KEY, "-inf", now - WAITING_LOOKBACK_MS);
  await r.zremrangebyscore(DRAINED_KEY, "-inf", now - WAITING_LOOKBACK_MS);
  const stale = await r.zrangebyscore(ENQUEUED_KEY, "-inf", now - SWEEP_STALE_MS, "WITHSCORES");
  const members: string[] = [];
  const enqueuedAt: number[] = [];
  for (let i = 0; i < stale.length; i += 2) {
    members.push(stale[i]);
    enqueuedAt.push(Number(stale[i + 1]));
  }
  if (members.length === 0) return [];
  const drained = await r.zmscore(DRAINED_KEY, ...members);
  return members
    .filter((_, i) => drained[i] === null || Number(drained[i]) - DRAIN_MARGIN_MS < enqueuedAt[i])
    .map((m) => {
      const [projectId, detectorId] = m.split(":");
      return { projectId, detectorId };
    });
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
