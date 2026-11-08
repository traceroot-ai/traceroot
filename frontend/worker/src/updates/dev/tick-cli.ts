/**
 * Run the due-schedule tick once, optionally as of a frozen instant, and print
 * what it did. Development and tests only; the real tick runs on a timer.
 *
 *   pnpm update:tick [--now 2026-11-09T09:05:00Z] [--times 2] [--parallel]
 */
import { parseArgs } from "node:util";
import { prisma } from "@traceroot/core";
import { createUpdateRunQueue } from "../queue.js";
import { runUpdateTick } from "../scheduler.js";
import { assertLocalStack } from "./seed/run.js";
import { assertManualTriggerAllowed } from "../trigger.js";

async function main(): Promise<void> {
  process.env.NODE_ENV ??= "development";
  assertManualTriggerAllowed();
  assertLocalStack();
  const { values } = parseArgs({
    options: { now: { type: "string" }, times: { type: "string" }, parallel: { type: "boolean" } },
  });
  const now = values.now ? new Date(values.now) : new Date();
  const times = Number(values.times ?? 1);
  const { queue, close } = createUpdateRunQueue();
  try {
    const one = () => runUpdateTick(prisma, queue, now);
    const results = values.parallel
      ? await Promise.all(Array.from({ length: times }, one))
      : await (async () => {
          const out = [];
          for (let i = 0; i < times; i += 1) out.push(await one());
          return out;
        })();
    console.log(JSON.stringify({ now: now.toISOString(), results }, null, 2));
  } finally {
    await close();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
