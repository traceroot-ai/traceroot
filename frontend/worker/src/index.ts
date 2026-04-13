/**
 * TraceRoot Worker
 *
 * Background job processor for:
 * - Billing (hourly): usage stats, free plan blocking, Stripe metering
 * - Future: email sending, data cleanup, etc.
 */

import cron from "node-cron";
import { prisma, syncStandardPrices } from "@traceroot/core";
import { runBillingJob, closeClickHouseClient } from "./ee/billing";

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
  console.log("[Worker] TraceRoot Worker starting...");

  // Test database connection
  try {
    const projectCount = await prisma.project.count();
    console.log(`[Worker] Connected to database. Found ${projectCount} projects.`);
  } catch (error) {
    console.error("[Worker] Failed to connect to database:", error);
    process.exit(1);
  }

  // Sync standard model pricing from JSON → DB
  await syncStandardPrices();

  // Schedule billing job (default: every hour at minute 5)
  const billingCron = process.env.USAGE_METERING_CRON || "5 * * * *";
  cron.schedule(billingCron, async () => {
    if (isShuttingDown) return;

    console.log("[Worker] Running scheduled billing job...");
    try {
      await runBillingJob();
    } catch (error) {
      console.error("[Worker] Billing job failed:", error);
    }
  });

  console.log("[Worker] Scheduled jobs:");
  console.log(`  - Billing: ${billingCron}`);
  console.log("[Worker] Worker is running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[Worker] Fatal error:", error);
  process.exit(1);
});
