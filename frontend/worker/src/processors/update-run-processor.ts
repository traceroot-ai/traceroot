import { Worker } from "bullmq";
import { prisma } from "@traceroot/core";
import { createRedisConnection } from "../queues/detector-run-queue.js";
import { aggregatesConfigFromEnv, readRunAggregates } from "../updates/aggregates-client.js";
import { executeRun } from "../updates/execute.js";
import { buildAgentStageDeps, sandboxProviderFromEnv } from "../updates/runtime.js";
import { UPDATE_RUN_QUEUE, type UpdateRunJob } from "../updates/queue.js";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export function startUpdateRunWorker(): Worker<UpdateRunJob> {
  const config = aggregatesConfigFromEnv();
  const sandbox = sandboxProviderFromEnv().catch((error) => {
    console.error("[Updates] no sandbox provider:", error instanceof Error ? error.message : error);
    return null;
  });
  const worker = new Worker<UpdateRunJob>(
    UPDATE_RUN_QUEUE,
    async (job) => {
      const outcome = await executeRun(
        {
          db: prisma,
          readAggregates: (projectId, windows, timezone) =>
            readRunAggregates(config, projectId, windows, timezone),
          appBaseUrl: APP_BASE_URL,
          agent: buildAgentStageDeps(config, await sandbox),
        },
        job.data.runId,
      );
      console.log(
        `[Updates] run=${job.data.runId} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
      );
      // A failed attempt throws so the queue retries it with backoff.
      if (outcome.status === "failed") throw new Error(outcome.error);
    },
    { connection: createRedisConnection(), concurrency: 2 },
  );
  worker.on("failed", (job, error) => {
    console.error(`[Updates] job ${job?.id} failed`, error.message);
  });
  return worker;
}
