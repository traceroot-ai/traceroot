import type { Queue } from "bullmq";
import { ALERT_WINDOWS, DEFAULT_ALERT_WINDOW, isAlertWindow } from "@traceroot/core";
import {
  createDetectorDigestQueue,
  createRedisConnection,
  windowStartFor,
  type DigestJob,
} from "../queues/digest-queue.js";

// Settle margin past the window's end before the flush reads ClickHouse, so a
// finding written at windowEnd−ε is visible. With finding-timestamp keying
// there is no RCA-latency drift, so a few seconds for write-visibility suffices.
const DIGEST_SETTLE_MS = Number(process.env.DIGEST_SETTLE_MS ?? 5_000);

let digestQueue: Queue<DigestJob> | null = null;
export function getDigestQueue(): Queue<DigestJob> {
  digestQueue ??= createDetectorDigestQueue(createRedisConnection());
  return digestQueue;
}

/** The project's notification window in ms: its alert window, or the default one. */
export function alertWindowMs(alertWindow: string | null | undefined): number {
  return ALERT_WINDOWS[
    alertWindow && isAlertWindow(alertWindow) ? alertWindow : DEFAULT_ALERT_WINDOW
  ];
}

/**
 * Schedule the per-finding digest flush for the window a finding falls in. One
 * deduped flush per (project, windowStart), keyed off the finding timestamp the
 * worker also stamps onto the detector_runs the flush counts, so the window the
 * key selects and the window the count reads are identical. The deterministic
 * jobId makes the first finding of the window schedule the flush and every
 * later finding a no-op; age-based retention keeps a late re-enqueue a no-op
 * past the largest window.
 */
export async function scheduleFindingDigest(
  projectId: string,
  findingTimestamp: number | undefined,
  alertWindow: string | null | undefined,
): Promise<void> {
  const windowMs = alertWindowMs(alertWindow);
  // Legacy/in-flight RCA jobs enqueued before findingTimestamp existed carry no
  // timestamp; fall back to now so the window key never goes NaN.
  const ts =
    typeof findingTimestamp === "number" && Number.isFinite(findingTimestamp)
      ? findingTimestamp
      : Date.now();
  const windowStart = windowStartFor(ts, windowMs);
  const delay = Math.max(0, windowStart + windowMs + DIGEST_SETTLE_MS - Date.now());
  await getDigestQueue().add(
    `digest-${projectId}-${windowStart}`,
    { projectId, windowStart, windowMs },
    {
      jobId: `digest:${projectId}:${windowStart}`,
      delay,
      removeOnComplete: { age: 6 * 3600 },
      removeOnFail: 50,
    },
  );
}
