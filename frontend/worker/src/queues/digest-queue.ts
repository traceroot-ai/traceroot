import { Queue } from "bullmq";
import { Redis } from "ioredis";

// Reuse the shared Redis connection factory rather than re-declaring config.
export { createRedisConnection } from "./detector-run-queue.js";

export const DETECTOR_DIGEST_QUEUE = "detector-digest";

/** A single coalesced flush for one project's alert window. */
export interface DigestFlushJob {
  projectId: string;
  windowStart: number; // ms epoch, floored to the window boundary
  windowMs: number; // window length in ms (from ALERT_WINDOWS)
}

/** Floor a finding timestamp to its window's start so every finding in the
 *  same window resolves to one deterministic flush key. */
export function windowStartFor(findingTsMs: number, windowMs: number): number {
  return Math.floor(findingTsMs / windowMs) * windowMs;
}

export function createDetectorDigestQueue(connection: Redis): Queue<DigestFlushJob> {
  return new Queue<DigestFlushJob>(DETECTOR_DIGEST_QUEUE, { connection });
}
