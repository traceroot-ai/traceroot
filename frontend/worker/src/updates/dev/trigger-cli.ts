/**
 * Start an update for a project now, optionally as of a frozen instant:
 *
 *   pnpm --filter traceroot-worker update:trigger -- --project <id> [--now 2026-11-02T09:30:00Z]
 *
 * Add --execute to also run it now, in this process, instead of leaving it to the
 * worker's queue; --facts-only then skips the agent and delivery.
 *
 * Development and tests only (see assertManualTriggerAllowed).
 */
import { parseArgs } from "node:util";
import { prisma } from "@traceroot/core";
import { frozenClock, systemClock } from "@traceroot/core/updates";
import { aggregatesConfigFromEnv, readRunAggregates } from "../aggregates-client.js";
import { executeRun } from "../execute.js";
import { buildAgentStageDeps, sandboxProviderFromEnv } from "../runtime.js";
import { triggerManualRun } from "../trigger.js";
import { assertLocalStack } from "./seed/run.js";

async function main(): Promise<void> {
  // This CLI exists for development; the guard still refuses a production value.
  process.env.NODE_ENV ??= "development";
  assertLocalStack();
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      now: { type: "string" },
      execute: { type: "boolean" },
      "facts-only": { type: "boolean" },
    },
  });
  if (!values.project) throw new Error("--project is required.");
  const frozen = values.now ?? process.env.TRACEROOT_UPDATES_FROZEN_NOW;
  const clock = frozen ? frozenClock(frozen) : systemClock;

  const { run, created } = await triggerManualRun(prisma, { projectId: values.project, clock });
  let executed: unknown;
  if (values.execute) {
    const config = aggregatesConfigFromEnv();
    executed = await executeRun(
      {
        db: prisma,
        readAggregates: (projectId, windows, timezone) =>
          readRunAggregates(config, projectId, windows, timezone),
        appBaseUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        ...(values["facts-only"]
          ? {}
          : { agent: buildAgentStageDeps(config, await sandboxProviderFromEnv()) }),
      },
      run.id,
    ).then((o) => ({ status: o.status, error: o.error }));
  }
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
        executed,
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
