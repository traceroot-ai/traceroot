import { DelayedError, Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { prisma } from "@traceroot/core";
import {
  DEFAULT_DAILY_COST_CAP_USD,
  TASK_GROUP_QUEUE,
  addTaskGroupSpend,
  utcDay,
} from "@traceroot/core/task-groups";
import { createRedisConnection } from "../../queues/detector-run-queue.js";
import { embedTexts } from "../signals/embedding.js";
import { signalsApiKey, signalsAvailable } from "../signals/config.js";
import { taskGroupBackend } from "./backend-client.js";
import { SKIP_AFTER_FAILURES, SKIP_TTL_MS, TICK_EVERY_MS } from "./config.js";
import { runDigestRound, type RoundDeps } from "./round.js";
import { createSummarizer } from "./summarize.js";

/** A round names its project; the tick job carries no project. */
export type TaskGroupJobData = { projectId: string } | { tick: true };

const ROUND_JOB = "digest";
const TICK_JOB = "tick";

let queue: Queue<TaskGroupJobData> | null = null;
export function getTaskGroupQueue(): Queue<TaskGroupJobData> {
  queue ??= new Queue<TaskGroupJobData>(TASK_GROUP_QUEUE, { connection: createRedisConnection() });
  return queue;
}

let bookkeeping: Redis | null = null;
function redis(): Redis {
  bookkeeping ??= createRedisConnection();
  return bookkeeping;
}

const failureKey = (projectId: string, traceId: string) =>
  `taskgroups:fail:${projectId}:${traceId}`;

export function productionDeps(): RoundDeps {
  // Read per job so a key added to the environment takes effect on restart.
  const apiKey = signalsApiKey() ?? "";
  return {
    backend: taskGroupBackend,
    apiKeyConfigured: signalsAvailable,
    settings: async (projectId) => {
      const row = await prisma.taskGroupSettings.findUnique({ where: { projectId } });
      return {
        enabled: row?.enabled ?? false,
        dailyCostCapUsd: row?.dailyCostCapUsd ?? DEFAULT_DAILY_COST_CAP_USD,
      };
    },
    spentToday: async (projectId, nowMs) => {
      const row = await prisma.taskGroupSpendDay.findUnique({
        where: { projectId_day: { projectId, day: utcDay(new Date(nowMs)) } },
      });
      return row?.costUsd ?? 0;
    },
    addSpend: (projectId, nowMs, spend) =>
      addTaskGroupSpend(prisma, { projectId, now: new Date(nowMs), ...spend }),
    summarize: (text) => createSummarizer(apiKey)(text),
    embed: (texts) => embedTexts(texts, apiKey),
    failures: {
      record: async (projectId, traceId) => {
        const key = failureKey(projectId, traceId);
        const count = await redis().incr(key);
        await redis().pexpire(key, SKIP_TTL_MS);
        return count;
      },
      isSkipped: async (projectId, traceId) =>
        Number((await redis().get(failureKey(projectId, traceId))) ?? 0) >= SKIP_AFTER_FAILURES,
    },
    now: Date.now,
  };
}

/** Add the project's round. The fixed job id keeps one round per project. */
export async function enqueueRound(projectId: string, delayMs = 0): Promise<void> {
  await getTaskGroupQueue().add(
    ROUND_JOB,
    { projectId },
    {
      jobId: `round-${projectId}`,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 2,
      backoff: { type: "exponential", delay: 15_000 },
    },
  );
}

/** Enqueue a round for every project that has the feature on. */
export async function enqueueEnabledProjects(): Promise<number> {
  if (!signalsAvailable()) return 0;
  const rows = await prisma.taskGroupSettings.findMany({
    where: { enabled: true },
    select: { projectId: true },
  });
  for (const r of rows) await enqueueRound(r.projectId);
  return rows.length;
}

export async function processTaskGroupJob(
  job: Job<TaskGroupJobData>,
  token?: string,
  deps: RoundDeps = productionDeps(),
): Promise<void> {
  if ("tick" in job.data) {
    await enqueueEnabledProjects();
    return;
  }
  const { projectId } = job.data;
  const stats = await runDigestRound(deps, projectId);
  console.log(`[TaskGroups] ${projectId} ${JSON.stringify(stats)}`);
  // More to do: yield and continue at once, keeping the job id.
  if (stats.more && !stats.skipped) {
    await job.moveToDelayed(Date.now(), token);
    throw new DelayedError();
  }
}

export function startTaskGroupWorker(): Worker<TaskGroupJobData> {
  const worker = new Worker<TaskGroupJobData>(
    TASK_GROUP_QUEUE,
    (job, token) => processTaskGroupJob(job, token),
    { connection: createRedisConnection(), concurrency: 2, lockDuration: 180_000 },
  );
  worker.on("failed", (job, err) => {
    if (err instanceof DelayedError) return;
    console.error(`[TaskGroups] job ${job?.id} failed:`, err.message);
  });
  getTaskGroupQueue()
    .upsertJobScheduler(
      "task-group-tick",
      { every: TICK_EVERY_MS },
      {
        name: TICK_JOB,
        data: { tick: true },
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    )
    .catch((err) => console.error("[TaskGroups] failed to schedule the tick:", err));
  return worker;
}
