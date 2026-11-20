/**
 * The web app's scheduled tick.
 *
 * Every 15 minutes this service asks the web app to run its periodic work
 * (`POST /api/internal/scheduled-tick`). The schedule lives here because this
 * service already runs BullMQ; the work lives in the web app, which owns the data
 * and the settings it needs.
 *
 * One job scheduler with a fixed id, upserted by every replica, so each tick runs
 * once however many detector processes there are. A failed tick is retried with
 * backoff. A tick can still run twice or overlap the next one (a retry, or a tick
 * slower than the interval); the web app makes each task safe for that.
 */
import { Queue, Worker } from "bullmq";
import { createRedisConnection } from "../queues/detector-run-queue.js";

export const WEB_TICK_QUEUE = "web-tick";
export const WEB_TICK_SCHEDULER_ID = "web-tick";
export const WEB_TICK_EVERY_MS = 15 * 60 * 1000;
export const WEB_TICK_PATH = "/api/internal/scheduled-tick";

/** How long the web app has to answer before the attempt counts as failed. */
export const WEB_TICK_TIMEOUT_MS = 60_000;
/** Attempts per tick, the first one included; retries back off from 30s. */
export const WEB_TICK_ATTEMPTS = 3;
const WEB_TICK_BACKOFF_MS = 30_000;

let warnedNoSecret = false;

/** Aborted on shutdown, cancelling the request of a tick in progress. */
const shuttingDown = new AbortController();

/** One tick: asks the web app to run its periodic work. Throws on failure, so BullMQ retries. */
export async function runWebTick(): Promise<void> {
  const secret = process.env.INTERNAL_API_SECRET || "";
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn("[Web tick] INTERNAL_API_SECRET is not set; the web app's tick is skipped");
      warnedNoSecret = true;
    }
    return;
  }
  const webUrl = process.env.TRACEROOT_UI_URL || "http://localhost:3000";
  const response = await fetch(`${webUrl}${WEB_TICK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
    body: "{}",
    signal: AbortSignal.any([AbortSignal.timeout(WEB_TICK_TIMEOUT_MS), shuttingDown.signal]),
  });
  if (!response.ok) {
    throw new Error(`web tick answered ${response.status}`);
  }
}

let queue: Queue | undefined;

function getWebTickQueue(): Queue {
  if (!queue) {
    queue = new Queue(WEB_TICK_QUEUE, { connection: createRedisConnection() });
  }
  return queue;
}

export function startWebTickWorker(): Worker {
  const worker = new Worker(WEB_TICK_QUEUE, () => runWebTick(), {
    connection: createRedisConnection(),
    concurrency: 1,
    // Held past the request timeout, so a slow tick is not handed to a second worker.
    lockDuration: WEB_TICK_TIMEOUT_MS * 2,
  });
  worker.on("failed", (job, err) => {
    console.error(`[Web tick] attempt ${job?.attemptsMade ?? "?"} failed:`, err.message);
  });
  // Idempotent: every worker process upserts the same scheduler.
  getWebTickQueue()
    .upsertJobScheduler(
      WEB_TICK_SCHEDULER_ID,
      { every: WEB_TICK_EVERY_MS },
      {
        name: "tick",
        data: {},
        opts: {
          attempts: WEB_TICK_ATTEMPTS,
          backoff: { type: "exponential", delay: WEB_TICK_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    )
    .catch((err) => console.error("[Web tick] failed to schedule the tick:", err));
  return worker;
}

/**
 * Stops the worker without waiting out a tick in progress, which can take most of
 * the request timeout while the stop grace is shorter (10s under compose). The
 * tick's request is cancelled, so its job fails and is retried later; the web app
 * finishes or gives back what it started, and each task is safe to run again.
 */
export async function closeWebTickWorker(worker: Worker): Promise<void> {
  shuttingDown.abort(new Error("the detector service is shutting down"));
  await worker.close();
}
