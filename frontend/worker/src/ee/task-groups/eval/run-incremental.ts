/**
 * Evaluation CLI: run the incremental baseline over a project's exported summaries.
 *
 *   tsx run-incremental.ts <digests.json> <out.json> [--shuffle <seed>]
 *
 * <digests.json> comes from scripts/topic_corpus/export_digests.py. The output holds the
 * assignments, the groups, the number of model calls, the cost and the run time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { assignIncrementally, type Item } from "./incremental.js";
import { createModelJudge } from "./judge.js";

function shuffle<T>(items: T[], seed: number): T[] {
  // mulberry32: a small seeded generator, so a shuffled run can be repeated.
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const [input, output, flag, seedArg] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: run-incremental.ts <digests.json> <out.json> [--shuffle <seed>]");
  process.exit(2);
}
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENAI_API_KEY is empty");
  process.exit(2);
}
const digests = JSON.parse(readFileSync(input, "utf8")) as {
  trace_id: string;
  trace_time_ms: number;
  summary: string;
  embedding: number[];
}[];
let items: Item[] = digests
  .map((d) => ({
    traceId: d.trace_id,
    traceTimeMs: d.trace_time_ms,
    summary: d.summary,
    embedding: d.embedding,
  }))
  .sort((a, b) => a.traceTimeMs - b.traceTimeMs || (a.traceId < b.traceId ? -1 : 1));
if (flag === "--shuffle") items = shuffle(items, Number(seedArg ?? 1));

const { judge, usage } = createModelJudge(apiKey);
const started = Date.now();
const result = await assignIncrementally(items, judge);
const seconds = (Date.now() - started) / 1000;
writeFileSync(
  output,
  JSON.stringify(
    {
      items: items.length,
      order: flag === "--shuffle" ? `shuffled:${seedArg}` : "time",
      groups: result.groups.map((g) => ({
        id: g.id,
        title: g.title,
        covers: g.covers,
        size: g.size,
      })),
      assignments: result.assignments,
      choose_calls: result.chooseCalls,
      describe_calls: result.describeCalls,
      model_calls: usage.calls,
      cost_usd: usage.costUsd,
      seconds,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify({
    items: items.length,
    groups: result.groups.length,
    calls: usage.calls,
    usd: +usage.costUsd.toFixed(4),
    seconds,
  }),
);
process.exit(0);
