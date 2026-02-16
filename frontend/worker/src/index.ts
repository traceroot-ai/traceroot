/**
 * Traceroot Worker
 *
 * Background job processor for:
 * - Usage metering (hourly)
 * - Future: email sending, data cleanup, etc.
 */

import cron from "node-cron";
import { prisma } from "@traceroot/core";
import { runUsageMeteringJob, closeClickHouseClient } from "./billing";

// Graceful shutdown handling
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Worker] Received ${signal}, shutting down gracefully...`);

  try {
    await closeClickHouseClient();
    await prisma.$disconnect();
    console.log("[Worker] Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("[Worker] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[Worker] Traceroot Worker starting...");

  // Test database connection
  try {
    const projectCount = await prisma.project.count();
    console.log(`[Worker] Connected to database. Found ${projectCount} projects.`);
  } catch (error) {
    console.error("[Worker] Failed to connect to database:", error);
    process.exit(1);
  }

  // Schedule usage metering job (default: every hour at minute 5)
  const meteringCron = process.env.USAGE_METERING_CRON || "5 * * * *";
  cron.schedule(meteringCron, async () => {
    if (isShuttingDown) return;

    console.log("[Worker] Running scheduled usage metering job...");
    try {
      await runUsageMeteringJob();
    } catch (error) {
      console.error("[Worker] Usage metering job failed:", error);
    }
  });

  console.log("[Worker] Scheduled jobs:");
  console.log(`  - Usage metering: ${meteringCron}`);

  // Run initial job on startup (optional, for catching up)
  if (process.env.RUN_METERING_ON_STARTUP === "true") {
    console.log("[Worker] Running initial usage metering job...");
    try {
      await runUsageMeteringJob();
    } catch (error) {
      console.error("[Worker] Initial usage metering job failed:", error);
    }
  }

  console.log("[Worker] Worker is running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[Worker] Fatal error:", error);
  process.exit(1);
});
