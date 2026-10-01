import { DelayedError, Worker, type Job } from "bullmq";
import { prisma } from "@traceroot/core";
import { SIGNAL_ASSIGN_QUEUE } from "@traceroot/core/signals";
import { createRedisConnection } from "../../queues/detector-run-queue.js";
import {
  ASSIGN_CONCURRENCY,
  ASSIGN_DELAY_MS,
  ASSIGN_LOCK_DURATION_MS,
  SWEEP_EVERY_MS,
  signalsApiKey,
  signalsAvailable,
} from "./config.js";
import { signalsBackend } from "./backend-client.js";
import { embedTexts } from "./embedding.js";
import { createChatModels, createJevModels, findJevProvider } from "./models.js";
import {
  SWEEP_JOB_NAME,
  enqueueAssignment,
  getSignalAssignQueue,
  markDrained,
  partitionsToSweep,
  recordHitFailure,
  type SignalAssignJobData,
} from "./queue.js";
import { enqueueSignalRca, sweepSignalRcas } from "./rca.js";
import { runAssignmentRound, type RoundDeps } from "./round.js";

function productionDeps(): RoundDeps {
  // Read per job so a key added to the environment takes effect on restart
  // without code paths caching a missing key. The round drops hits when it is
  // missing, before these are called.
  const apiKey = signalsApiKey() ?? "";
  return {
    db: prisma,
    backend: signalsBackend,
    failures: { record: recordHitFailure },
    enqueueRca: (findingId, projectId) => enqueueSignalRca(findingId, projectId),
    embed: (texts) => embedTexts(texts, apiKey),
    models: async (workspaceId, usage) => {
      const jevConfig = await findJevProvider(prisma, workspaceId);
      return {
        chat: createChatModels(apiKey, usage),
        jev: jevConfig ? createJevModels(jevConfig, usage) : null,
      };
    },
    now: Date.now,
  };
}

/**
 * Re-enqueue partitions whose job may have been lost (see partitionsToSweep).
 * Enqueueing a partition whose job is alive is a no-op.
 */
export async function sweepPartitions(now: number = Date.now()): Promise<number> {
  // Projection repair is independent of the model key and ClickHouse's
  // waiting query. The partial index only scans unacknowledged placements.
  const pending = await prisma.signalHit.findMany({
    where: { copyPending: true },
    select: { projectId: true, detectorId: true },
    distinct: ["projectId", "detectorId"],
    take: 500,
  });
  const waiting = signalsAvailable() ? await partitionsToSweep(now) : [];
  const partitions = [
    ...new Map(
      [...pending, ...waiting].map((p) => [`${p.projectId}:${p.detectorId}`, p] as const),
    ).values(),
  ];
  for (const p of partitions) await enqueueAssignment(p.projectId, p.detectorId, 0);
  if (partitions.length > 0)
    console.log(`[Signals] sweeper re-enqueued ${partitions.length} partition(s)`);
  if (signalsAvailable()) await sweepSignalRcas(prisma, now);
  return partitions.length;
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
