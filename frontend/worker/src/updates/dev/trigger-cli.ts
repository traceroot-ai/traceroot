/**
 * Start an update for a project now, optionally as of a frozen instant:
 *
 *   pnpm --filter traceroot-worker update:trigger -- --project <id> [--now 2026-11-02T09:30:00Z]
 *
 * Development and tests only (see assertManualTriggerAllowed).
 */
import { parseArgs } from "node:util";
import { prisma } from "@traceroot/core";
import { frozenClock, systemClock } from "@traceroot/core/updates";
import { triggerManualRun } from "../trigger.js";

async function main(): Promise<void> {
  // This CLI exists for development; the guard still refuses a production value.
  process.env.NODE_ENV ??= "development";
  const { values } = parseArgs({
    options: { project: { type: "string" }, now: { type: "string" } },
  });
  if (!values.project) throw new Error("--project is required.");
  const frozen = values.now ?? process.env.TRACEROOT_UPDATES_FROZEN_NOW;
  const clock = frozen ? frozenClock(frozen) : systemClock;

  const { run, created } = await triggerManualRun(prisma, { projectId: values.project, clock });
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        created,
        trigger: run.trigger,
        slotAt: run.slotAt.toISOString(),
        windowStart: run.windowStart.toISOString(),
        windowEnd: run.windowEnd.toISOString(),
        prevWindowStart: run.prevWindowStart.toISOString(),
        prevWindowEnd: run.prevWindowEnd.toISOString(),
        status: run.status,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
