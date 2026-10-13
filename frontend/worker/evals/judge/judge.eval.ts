/**
 * Detector-judge model comparison (issue #2485).
 *
 * Runs the production judge — runDetectionForTrace, unchanged: same system
 * prompt, submit_result tool, retry-on-text and truncation — over the labeled
 * traces in cases.json, once per candidate model. Models are reached through
 * OpenRouter by stubbing the workspace BYOK lookup, the same path a workspace
 * with an OpenRouter provider takes.
 *
 *   python3 evals/judge/build_cases.py
 *   JUDGE_MODELS=anthropic/claude-haiku-4.5,openai/gpt-6-luna JUDGE_REPEATS=2 \
 *     npx dotenv -e ../../.env -- npx vitest run --config evals/judge/vitest.config.ts
 *
 * Writes one JSON line per (model, case, repeat) to evals/judge/.results/.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, vi } from "vitest";

vi.mock("@traceroot/core/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core/model-resolver")>();
  return {
    ...actual,
    fetchProviderConfig: async () => ({
      adapter: "openrouter",
      key: process.env.OPENROUTER_API_KEY!,
      baseUrl: null,
      config: null,
    }),
  };
});

const { runDetectionForTrace } = await import("../../src/detection/sandbox-eval.js");

interface Case {
  id: string;
  detectorKey: string;
  detector: {
    name: string;
    prompt: string;
    outputSchema: Array<{ name: string; type: string }>;
    template: string | null;
  };
  expected: boolean;
  evidence: string[];
  spansJsonl: string;
}

const CASES: Case[] = JSON.parse(
  readFileSync(fileURLToPath(new URL(process.env.JUDGE_SET ?? "cases.json", import.meta.url)), "utf8"),
);
const MODELS = (process.env.JUDGE_MODELS ?? "anthropic/claude-haiku-4.5").split(",");
const REPEATS = Number(process.env.JUDGE_REPEATS ?? 1);
const CONCURRENCY = Number(process.env.JUDGE_CONCURRENCY ?? 6);
const ONLY = process.env.JUDGE_CASES?.split(",");
const RESULTS_DIR = fileURLToPath(new URL(".results/", import.meta.url));
const OUT = `${RESULTS_DIR}${process.env.JUDGE_RUN ?? new Date().toISOString().slice(0, 19)}.jsonl`;

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

describe("detector judge model comparison", () => {
  it("runs every case on every model", async () => {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const cases = ONLY ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
    const jobs = MODELS.flatMap((model) =>
      cases.flatMap((c) => Array.from({ length: REPEATS }, (_, repeat) => ({ model, c, repeat }))),
    );
    console.log(`${jobs.length} judge calls -> ${OUT}`);
    let done = 0;

    await pool(jobs, CONCURRENCY, async ({ model, c, repeat }) => {
      const started = Date.now();
      const result = await runDetectionForTrace({
        traceId: c.id,
        spansJsonl: c.spansJsonl,
        workspaceId: "judge-eval",
        detector: {
          id: c.id,
          name: c.detector.name,
          prompt: c.detector.prompt,
          outputSchema: c.detector.outputSchema,
          template: c.detector.template,
          detectionModel: model,
          detectionProvider: "openrouter",
          detectionSource: "byok",
        },
      });
      const line = {
        model,
        case: c.id,
        detector: c.detectorKey,
        repeat,
        expected: c.expected,
        identified: result.error ? null : result.identified,
        correct: result.error ? false : result.identified === c.expected,
        summary: result.summary,
        data: result.data,
        error: result.error ?? null,
        latencyMs: Date.now() - started,
        inputTokens: result.inferenceInputTokens,
        outputTokens: result.inferenceOutputTokens,
        reportedCost: result.inferenceCost,
        promptChars: Math.min(c.spansJsonl.length, 150_000) + c.detector.prompt.length + 900,
      };
      appendFileSync(OUT, JSON.stringify(line) + "\n");
      done++;
      const mark = line.error ? "ERR" : line.correct ? "ok " : "XX ";
      console.log(`[${done}/${jobs.length}] ${mark} ${model} ${c.id} ${line.latencyMs}ms`);
    });
  });
});
