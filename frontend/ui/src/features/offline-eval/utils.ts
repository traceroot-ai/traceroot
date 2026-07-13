/**
 * Offline Evaluation — helpers and route builders.
 */

import { formatDate } from "@/lib/utils";
import type { ResultStatus, ReviewStatus } from "./types";

/** v1 navigation: Traces, Datasets, Evaluations, Scorers. */
export function evalRoutes(projectId: string) {
  const base = `/projects/${projectId}/offline-eval`;
  return {
    base,
    traces: `${base}/traces`,
    trace: (traceId: string) => `${base}/traces?trace=${traceId}`,
    datasets: `${base}/datasets`,
    dataset: (datasetId: string) => `${base}/datasets/${datasetId}`,
    datasetCase: (datasetId: string, caseId: string) =>
      `${base}/datasets/${datasetId}?case=${caseId}`,
    evaluations: `${base}/evaluations`,
    evaluation: (evaluationId: string) => `${base}/evaluations/${evaluationId}`,
    scorers: `${base}/scorers`,
  };
}

/** Badge variants for the status labels. Muted on purpose. */
export const RESULT_STATUS_VARIANT: Record<ResultStatus, "success" | "danger" | "warning"> = {
  passed: "success",
  failed: "danger",
  needs_review: "warning",
};

export const REVIEW_STATUS_VARIANT: Record<ReviewStatus, "success" | "warning"> = {
  reviewed: "success",
  needs_review: "warning",
};

/** e.g. 93.8 → "93.8%" */
export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** e.g. 22.4 → "+22.4", -9.5 → "−9.5" (true minus sign). */
export function signed(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
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

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The Python SDK snippet copied by "Copy init code" on a dataset. */
export function datasetInitCode(datasetName: string): string {
  return `import traceroot

ds = traceroot.dataset("${datasetName}")

ds.add(
    input="…",
    expected="…",
)

ds.publish()`;
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
