import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createRedisConnection } from "../queues/detector-run-queue.js";

export const UPDATE_RUN_QUEUE = "project-update-run";

export interface UpdateRunJob {
  runId: string;
  projectId: string;
}

export interface UpdateRunQueue {
  /** Needed only to replace a finished job under the same id. */
  getJob?(id: string): Promise<{ remove(): Promise<void> } | undefined | null>;
  add(
    name: string,
    data: UpdateRunJob,
    opts: {
      jobId: string;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
      removeOnComplete: { age: number };
      removeOnFail: { age: number };
    },
  ): Promise<unknown>;
}

/** The queue and its connection; close both when done (a queue does not close a connection it was given). */
export function createUpdateRunQueue(connection: Redis = createRedisConnection()): {
  queue: Queue<UpdateRunJob>;
  close: () => Promise<void>;
} {
  const queue = new Queue<UpdateRunJob>(UPDATE_RUN_QUEUE, { connection });
  return {
    queue,
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
}

/**
 * The job id is the same for the same run however many times it is added, so a
 * second tick, a second worker or a recovery pass cannot start it twice. A
 * scheduled run is named by project and slot, a manual one by its run id.
 */
export function updateRunJobId(run: {
  id: string;
  projectId: string;
  trigger: string;
  slotAt: Date;
}): string {
  return run.trigger === "scheduled"
    ? `update:${run.projectId}:${run.slotAt.getTime()}`
    : `update:manual:${run.id}`;
}

export async function enqueueUpdateRun(
  queue: UpdateRunQueue,
  run: { id: string; projectId: string; trigger: string; slotAt: Date },
  options: { replace?: boolean } = {},
): Promise<void> {
  // A finished job keeps its id for a week, which would turn a second add into a no-op.
  // A run taken back from a dead worker has to replace it.
  if (options.replace) {
    const old = await queue.getJob?.(updateRunJobId(run));
    await old?.remove().catch(() => undefined);
  }
  await queue.add(
    "update-run",
    { runId: run.id, projectId: run.projectId },
    {
      jobId: updateRunJobId(run),
      // A failed attempt is retried a few times; the run row says which attempt it is.
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}
