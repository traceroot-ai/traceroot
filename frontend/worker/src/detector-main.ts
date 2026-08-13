/**
 * TraceRoot Detector Worker
 *
 * Background job processor for:
 * - Detector runs: BullMQ worker for evaluating detectors against traces
 * - Detector RCA: BullMQ worker for root cause analysis of findings
 */

import { prisma } from "@traceroot/core";
import { startDetectorRunWorker } from "./processors/detector-run-processor.js";
import { startDetectorRcaWorker } from "./processors/detector-rca-processor.js";
import { startDetectorDigestWorker } from "./processors/detector-digest-processor.js";
import { initSelfTraceEmitter, shutdownSelfTraceEmitter } from "./detection/self-trace-emitter.js";
import { isAlertsSchedulerEnabled, startAlertScheduler } from "./alerts/scheduler.js";
import { logInfo } from "./alerts/log.js";
import { startAlertNotificationWorker } from "./notifications/alert-slack.js";

// Graceful shutdown handling
let isShuttingDown = false;
let detectorRunWorker: ReturnType<typeof startDetectorRunWorker> | undefined;
let detectorRcaWorker: ReturnType<typeof startDetectorRcaWorker> | undefined;
let detectorDigestWorker: ReturnType<typeof startDetectorDigestWorker> | undefined;
let alertNotificationWorker: ReturnType<typeof startAlertNotificationWorker> | undefined;
let alertScheduler: ReturnType<typeof startAlertScheduler> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Detector Worker] Received ${signal}, shutting down gracefully...`);

  try {
    if (alertScheduler) {
      alertScheduler.stop();
    }
    if (alertNotificationWorker) {
      await alertNotificationWorker.close();
    }
    if (detectorRunWorker) {
      await detectorRunWorker.close();
    }
    if (detectorRcaWorker) {
      await detectorRcaWorker.close();
    }
    if (detectorDigestWorker) {
      await detectorDigestWorker.close();
    }
    // Flush batched self-trace spans; shutdownSelfTraceEmitter catches
    // internally so an export failure cannot crash shutdown.
    await shutdownSelfTraceEmitter();
    await prisma.$disconnect();
    console.log("[Detector Worker] Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("[Detector Worker] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[Detector Worker] starting...");

  // Test database connection
  try {
    const projectCount = await prisma.project.count();
    console.log(`[Detector Worker] Connected to database. Found ${projectCount} projects.`);
  } catch (error) {
    console.error("[Detector Worker] Failed to connect to database:", error);
    process.exit(1);
  }

  // Start BullMQ detector run worker
  detectorRunWorker = startDetectorRunWorker();
  console.log("[Detector Worker] Detector run worker started");

  // Start BullMQ detector RCA worker
  detectorRcaWorker = startDetectorRcaWorker();
  console.log("[Detector Worker] Detector RCA worker started");

  // Start BullMQ detector digest worker
  detectorDigestWorker = startDetectorDigestWorker();
  console.log("[Detector Worker] Detector digest worker started");

  // Alert delivery consumer and the once-a-minute evaluation tick. Both live
  // here rather than in a process of their own (ruling B5), and the flag gates
  // both at boot: a consumer started when alerting is off would page from a
  // backlog nobody is watching. Only the tick re-reads the flag afterwards, so
  // a switch flipped later stops new pages while the consumer drains what is
  // already queued — bounded by each job's retry budget, and by the staleness
  // check that drops a job whose emission the rule has since moved past.
  if (isAlertsSchedulerEnabled()) {
    alertNotificationWorker = startAlertNotificationWorker();
    alertScheduler = startAlertScheduler();
  } else {
    logInfo('alerts disabled (set ALERTS_SCHEDULER_ENABLED="true" to run them)');
  }

  // Construct the self-trace emitter up front so the first detector run does
  // not pay the provider setup, and misconfiguration (no secret) logs at boot.
  // Best-effort like every other tracing path: runs degrade to untraced rather
  // than the worker crashing. The emitter latches its own errors internally, so
  // an init failure is never retried (a missing secret is the deliberate
  // exception — it re-checks each run so a late-injected env still takes effect,
  // and logs only once). This try/catch is therefore belt-and-braces against a
  // future throwing path, not the mechanism — nothing it calls today escapes.
  try {
    initSelfTraceEmitter();
  } catch (error) {
    console.error("[Detector Worker] self-trace emitter init failed at boot:", error);
  }

  console.log("[Detector Worker] Workers are running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[Detector Worker] Fatal error:", error);
  process.exit(1);
});
