import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

export { createRedisConnection } from "./detector-run-queue.js";

export const LOOP_RUN_QUEUE = "loop-run";

/** The job carries only the run: the processor reads everything else when it runs. */
export interface LoopRunJob {
  runId: string;
}

/** What enqueueing needs of a queue; a test passes a fake. */
export interface LoopQueue {
  add(name: string, data: LoopRunJob, opts: JobsOptions): Promise<unknown>;
}

/**
 * One job id per run, so a second tick or replica enqueueing the same pending
 * run is a no-op. Jobs are removed once they finish, which frees the id for a
 * run that was reclaimed, or whose job failed before the run started.
 */
export function loopRunJobId(runId: string): string {
  return `loop-run-${runId}`;
}

export function createLoopRunQueue(connection: Redis): Queue<LoopRunJob> {
  return new Queue<LoopRunJob>(LOOP_RUN_QUEUE, { connection });
}

export async function enqueueLoopRun(queue: LoopQueue, runId: string): Promise<void> {
  await queue.add(
    "loop-run",
    { runId },
    {
      jobId: loopRunJobId(runId),
      // One BullMQ attempt: the tick's reclaim is the only retry.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}
