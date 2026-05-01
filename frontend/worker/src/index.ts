/**
 * TraceRoot Billing Worker
 *
 * Background job processor for:
 * - Billing (hourly): usage stats, free plan blocking, Stripe metering
 */

import cron from "node-cron";
import { prisma, syncStandardPrices } from "@traceroot/core";
import { runBillingJob, closeClickHouseClient } from "./ee/billing";

// Graceful shutdown handling
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Billing Worker] Received ${signal}, shutting down gracefully...`);

  try {
    await closeClickHouseClient();
    await prisma.$disconnect();
    console.log("[Billing Worker] Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("[Billing Worker] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[Billing Worker] TraceRoot Billing Worker starting...");

  // Test database connection
  try {
    const projectCount = await prisma.project.count();
    console.log(`[Billing Worker] Connected to database. Found ${projectCount} projects.`);
  } catch (error) {
    console.error("[Billing Worker] Failed to connect to database:", error);
    process.exit(1);
  }

  // Sync standard model pricing from JSON → DB
  await syncStandardPrices();

  // Schedule billing job (default: every hour at minute 5)
  const billingCron = process.env.USAGE_METERING_CRON || "5 * * * *";
  cron.schedule(billingCron, async () => {
    if (isShuttingDown) return;

    console.log("[Billing Worker] Running scheduled billing job...");
    try {
      await runBillingJob();
    } catch (error) {
      console.error("[Billing Worker] Billing job failed:", error);
    }
  });

  console.log("[Billing Worker] Scheduled jobs:");
  console.log(`  - Billing: ${billingCron}`);
  console.log("[Billing Worker] Worker is running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[Billing Worker] Fatal error:", error);
  process.exit(1);
});
