import { DelayedError, Worker, type Job } from "bullmq";
import { prisma } from "@traceroot/core";
import { SIGNAL_ASSIGN_QUEUE } from "@traceroot/core/signals";
import { createRedisConnection } from "../../queues/detector-run-queue.js";
import {
  ASSIGN_CONCURRENCY,
  ASSIGN_DELAY_MS,
  ASSIGN_LOCK_DURATION_MS,
  SWEEP_EVERY_MS,
  managedJevKey,
  signalsApiKey,
  signalsAvailable,
} from "./config.js";
import { signalsBackend } from "./backend-client.js";
import { embedTexts } from "./embedding.js";
import { createChatModels, createJevModels } from "./models.js";
import {
  SWEEP_JOB_NAME,
  enqueueAssignment,
  getSignalAssignQueue,
  markDrained,
  partitionsToSweep,
  remarkUnmarked,
  clearHitFailures,
  recordHitFailure,
  type SignalAssignJobData,
} from "./queue.js";
import { startSettledRcas, sweepSignalRcas } from "./rca.js";
import { runAssignmentRound, type RoundDeps } from "./round.js";

function productionDeps(): RoundDeps {
  // Read per job so a key added to the environment takes effect on restart
  // without code paths caching a missing key. The round drops hits when it is
  // missing, before these are called.
  const apiKey = signalsApiKey() ?? "";
  return {
    db: prisma,
    backend: signalsBackend,
    failures: { record: recordHitFailure, clear: clearHitFailures },
    startRcas: (projectId, findingIds) =>
      startSettledRcas(prisma, signalsBackend, projectId, findingIds),
    embed: (texts) => embedTexts(texts, apiKey),
    models: async (usage) => {
      const jevKey = managedJevKey();
      return {
        chat: createChatModels(apiKey, usage),
        jev: jevKey ? createJevModels(jevKey, usage) : null,
      };
    },
    now: Date.now,
  };
}

/**
 * Re-enqueue partitions whose job may have been lost or whose enqueue failed
 * (see partitionsToSweep), partitions whose pending mark could not be written
 * (see remarkUnmarked), and partitions with placements not yet copied to
 * ClickHouse. Enqueueing a partition whose job is alive is a no-op.
 */
export async function sweepPartitions(now: number = Date.now()): Promise<number> {
  // Projection repair is independent of the model key and ClickHouse's
  // waiting query. The partial index only scans unacknowledged placements.
  const waiting = signalsAvailable() ? await partitionsToSweep(now) : [];
  const waitingKeys = new Set(waiting.map((p) => `${p.projectId}:${p.detectorId}`));
  let cursor: { projectId: string; detectorId: string } | null = null;
  // First, partitions whose mark Postgres refused when their hit was detected.
  let count = await remarkUnmarked();
  // Page all pending partitions, rather than repeatedly retrying the first
  // batch during an outage. Retain only a page and the bounded waiting batch.
  const pageSize = 500;
  for (;;) {
    const pending: { projectId: string; detectorId: string }[] = await prisma.$queryRaw`
      SELECT DISTINCT project_id AS "projectId", detector_id AS "detectorId"
      FROM signal_hits
      WHERE copy_pending
        AND (${cursor?.projectId ?? null}::text IS NULL OR
             (project_id, detector_id) > (${cursor?.projectId ?? null}, ${cursor?.detectorId ?? null}))
      ORDER BY project_id, detector_id LIMIT ${pageSize}`;
    for (const p of pending) {
      await enqueueAssignment(p.projectId, p.detectorId, 0);
      waitingKeys.delete(`${p.projectId}:${p.detectorId}`);
      count++;
    }
    if (pending.length < pageSize) break;
    cursor = pending[pending.length - 1];
  }
  for (const p of waiting) {
    if (!waitingKeys.has(`${p.projectId}:${p.detectorId}`)) continue;
    await enqueueAssignment(p.projectId, p.detectorId, 0);
    count++;
  }
  if (count > 0) console.log(`[Signals] sweeper re-enqueued ${count} partition(s)`);
  if (signalsAvailable()) await sweepSignalRcas(prisma, signalsBackend, now);
  return count;
}

/**
 * Run one round for the job's partition. The job moves itself back to the
 * queue instead of looping, so other partitions get the worker between rounds;
 * it keeps its id, so the partition still has one job. While hits remain it
 * continues at once. After a round that did work it takes one more look after
 * ASSIGN_DELAY_MS, which picks up hits whose enqueue was swallowed while this
 * job was running. It completes only after a round that found nothing waiting,
 * and records that read for the sweeper.
 */
export async function processSignalAssignJob(
  job: Job<SignalAssignJobData>,
  token?: string,
  deps: RoundDeps = productionDeps(),
): Promise<void> {
  if (job.name === SWEEP_JOB_NAME || "sweep" in job.data) {
    await sweepPartitions();
    return;
  }
  const { projectId, detectorId } = job.data;
  const stats = await runAssignmentRound(deps, projectId, detectorId);
  if (stats.remaining || stats.waiting > 0) {
    await job.moveToDelayed(Date.now() + (stats.remaining ? 0 : ASSIGN_DELAY_MS), token);
    throw new DelayedError();
  }
  // A round skipped for a missing key looked at nothing: leave the partition to
  // the sweeper, which resumes it once the key is configured.
  if (stats.skipped === "no-key") return;
  await markDrained(projectId, detectorId, stats.readAt);
}

export function startSignalAssignWorker(): Worker<SignalAssignJobData> {
  const worker = new Worker<SignalAssignJobData>(
    SIGNAL_ASSIGN_QUEUE,
    (job, token) => processSignalAssignJob(job, token),
    {
      connection: createRedisConnection(),
      concurrency: ASSIGN_CONCURRENCY,
      lockDuration: ASSIGN_LOCK_DURATION_MS,
    },
  );
  worker.on("failed", (job, err) => {
    // DelayedError is how a job yields between rounds, not a failure.
    if (err instanceof DelayedError) return;
    console.error(`[Signals] job ${job?.id} failed:`, err.message);
  });
  // Idempotent: every worker process upserts the same scheduler.
  getSignalAssignQueue()
    .upsertJobScheduler(
      "signal-assign-sweeper",
      { every: SWEEP_EVERY_MS },
      {
        name: SWEEP_JOB_NAME,
        data: { sweep: true },
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    )
    .catch((err) => console.error("[Signals] failed to schedule the sweeper:", err));
  return worker;
}
