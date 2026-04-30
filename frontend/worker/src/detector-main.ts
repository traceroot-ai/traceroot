/**
 * Traceroot Detector Worker
 *
 * Background job processor for:
 * - Detector runs: BullMQ worker for evaluating detectors against traces
 * - Detector RCA: BullMQ worker for root cause analysis of findings
 */

import { prisma } from "@traceroot/core";
import { startDetectorRunWorker } from "./processors/detector-run-processor.js";
import { startDetectorRcaWorker } from "./processors/detector-rca-processor.js";

// Graceful shutdown handling
let isShuttingDown = false;
let detectorRunWorker: ReturnType<typeof startDetectorRunWorker> | undefined;
let detectorRcaWorker: ReturnType<typeof startDetectorRcaWorker> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Detector Worker] Received ${signal}, shutting down gracefully...`);

  try {
    if (detectorRunWorker) {
      await detectorRunWorker.close();
    }
    if (detectorRcaWorker) {
      await detectorRcaWorker.close();
    }
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

  console.log("[Detector Worker] Workers are running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[Detector Worker] Fatal error:", error);
  process.exit(1);
});
