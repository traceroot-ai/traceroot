/**
 * Offline Evaluation — helpers and route builders.
 */

import { formatDate } from "@/lib/utils";
import type { ResultStatus, ReviewStatus } from "./types";

/** Badge variants for the status labels. Muted on purpose. */
export const RESULT_STATUS_VARIANT: Record<ResultStatus, "success" | "danger" | "warning"> = {
  passed: "success",
  failed: "danger",
  needs_review: "warning",
};

export const REVIEW_STATUS_VARIANT: Record<ReviewStatus, "success" | "warning"> = {
  ready: "success",
  needs_review: "warning",
};

/** e.g. 93.8 → "93.8%" (value already in 0–100 percentage points). */
export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/**
 * A 0–1 rate as a percentage, e.g. 0.857 → "85.7%". Server-backed evaluation main
 * scores are 0–1 fractions (not 0–100 values), so they use this.
 */
export function pctFraction(value: number, digits = 1): string {
  return pct(value * 100, digits);
}

/** e.g. 22.4 → "+22.4", -9.5 → "−9.5" (true minus sign). */
export function signed(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

/** A 0–1 delta as signed percentage points, e.g. -0.143 → "−14.3". */
export function signedPoints(value: number, digits = 1): string {
  return signed(value * 100, digits);
}

/**
 * Reads a change the way a person would, not by arithmetic sign. Everything in
 * v1 is higher-is-better, but the direction stays explicit.
 */
export function changeSentiment(change: number, higherIsBetter = true): "good" | "bad" | "neutral" {
  if (change === 0) return "neutral";
  const isUp = change > 0;
  return (higherIsBetter ? isUp : !isUp) ? "good" : "bad";
}

export const SENTIMENT_CLASS: Record<"good" | "bad" | "neutral", string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};

/** 0/1 scores read as Pass/Fail; fractional scores read as a percentage. */
export function scoreDisplay(value: number | null): string {
  if (value === null) return "—";
  if (value === 0 || value === 1) return value === 1 ? "Pass" : "Fail";
  return `${Math.round(value * 100)}%`;
}

/**
 * Absolute timestamp, matching the rest of the app.
 *
 * Delegates to `formatDate` from lib/utils so dataset/evaluation timestamps read
 * exactly like the traces and detectors tables ("2026-07-16 15:41:12"). That
 * helper is hand-built (no `toLocaleString`), so it stays hydration-safe for the
 * fixtures that render during SSR.
 */
export function formatStamp(iso: string): string {
  return formatDate(iso);
}

/**
 * A stable, trace-id-looking display id for a dataset row, derived from its
 * internal case id (which stays "case-001" for lookups/routes/refs).
 */
export function caseDisplayId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = (h >>> 0).toString(16).padStart(8, "0");
  const b = (Math.imul(h ^ 0x9e3779b9, 16777619) >>> 0).toString(16).padStart(8, "0");
  return `tc_${a}${b}`.slice(0, 15);
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The Python SDK snippet copied by "Copy init code" on a dataset. */
export function datasetInitCode(datasetName: string): string {
  return `import traceroot
from traceroot import Dataset

# Initialize with your API key, then author the dataset in code and
# publish it as one immutable server version.
traceroot.initialize()

ds = Dataset("${datasetName}")
ds.add(input="…", expected="…")

ds.push()`;
}

// ---------------------------------------------------------------------------
// Pull snippets. You only pull DATA: a dataset (its CURRENT version) or an exact
// immutable version. An evaluation series and a run id are identifiers, not
// runnable — so there is no "pull run" here. Reproducing a run = pulling that
// run's pinned dataset version. Each helper has a Python and a TypeScript form.
// ---------------------------------------------------------------------------

/** Python — pull the dataset's CURRENT published version (independent of any run). */
export function datasetPullCode(datasetId: string): string {
  return `import traceroot
from traceroot import pull_dataset

# Initialize with your API key so the pull is authenticated.
traceroot.initialize()

# Pull this dataset's CURRENT published version (moves as the dataset is edited).
dataset = pull_dataset("${datasetId}")

for case in dataset:
    print(case.id, case.input, case.expected)`;
}

/** TypeScript — pull the dataset's current published version. */
export function datasetPullCodeTs(datasetId: string): string {
  return `import * as traceroot from "traceroot";
import { pullDataset } from "traceroot";

// Initialize with your API key so the pull is authenticated.
traceroot.initialize();

// Pull this dataset's CURRENT published version (moves as the dataset is edited).
const dataset = await pullDataset("${datasetId}");

for (const testCase of dataset) {
  console.log(testCase.id, testCase.input, testCase.expected);
}`;
}

/** Python — pull one EXACT immutable dataset version by its version id. */
export function datasetPullVersionCode(versionId: string): string {
  return `import traceroot
from traceroot import pull_dataset_version

traceroot.initialize()

# Pull this EXACT version (an immutable snapshot — never changes).
dataset = pull_dataset_version("${versionId}")

for case in dataset:
    print(case.id, case.input, case.expected)`;
}

/** TypeScript — pull one exact immutable dataset version by its version id. */
export function datasetPullVersionCodeTs(versionId: string): string {
  return `import * as traceroot from "traceroot";
import { pullDatasetVersion } from "traceroot";

traceroot.initialize();

// Pull this EXACT version (an immutable snapshot — never changes).
const dataset = await pullDatasetVersion("${versionId}");

for (const testCase of dataset) {
  console.log(testCase.id, testCase.input, testCase.expected);
}`;
}

/**
 * Python — reproduce ONE run locally: pull the exact dataset version that run
 * scored (so a new candidate is measured on the same cases), then the commented
 * evaluate(... baseline=...) stub to run your candidate and compare against it.
 */
export function reproduceRunCode(versionId: string, evaluationName: string, runId: string): string {
  return `import traceroot
from traceroot import evaluate, pull_dataset_version

traceroot.initialize()

# The EXACT cases this run scored — pin them so a new candidate is comparable.
dataset = pull_dataset_version("${versionId}")

# Point task at your candidate; report baseline=this run to get the comparison.
# result = evaluate(
#     name=${JSON.stringify(evaluationName)},
#     data=dataset,
#     task=your_task,
#     scorers=[...],
#     candidate_version="git:REPLACE_ME",
#     baseline=${JSON.stringify(runId)},  # compare against this run
# )`;
}

/** TypeScript — reproduce one run locally (version pull + commented evaluate stub). */
export function reproduceRunCodeTs(
  versionId: string,
  evaluationName: string,
  runId: string,
): string {
  return `import * as traceroot from "traceroot";
import { evaluate, pullDatasetVersion } from "traceroot";

traceroot.initialize();

// The EXACT cases this run scored — pin them so a new candidate is comparable.
const dataset = await pullDatasetVersion("${versionId}");

// Point task at your candidate; report baseline=this run to get the comparison.
// const result = await evaluate({
//   name: ${JSON.stringify(evaluationName)},
//   data: dataset,
//   task: yourTask,
//   scorers: [...],
//   candidateVersion: "git:REPLACE_ME",
//   baseline: ${JSON.stringify(runId)}, // compare against this run
// });`;
}

/** The TypeScript SDK snippet for a dataset. */
export function datasetInitCodeTs(datasetName: string): string {
  return `import { dataset } from "traceroot";

const ds = dataset("${datasetName}");

ds.add({
  input: "…",
  expected: "…",
});

await ds.publish();`;
}

/** Parses a span's JSON metadata string into a flat record for display. */
export function parseMetadata(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // Non-JSON metadata is shown as a single value.
    return { value: raw };
  }
  return {};
}
