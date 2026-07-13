/**
 * Offline Evaluation — shared helpers and route builders.
 */

import type { GoldenStatus, RowOutcome, Severity } from "./types";

/** All prototype routes live under one namespace so the area is self-contained. */
export function evalRoutes(projectId: string) {
  const base = `/projects/${projectId}/offline-eval`;
  return {
    base,
    overview: base,
    issue: (issueId: string) => `${base}/issues/${issueId}`,
    traces: `${base}/traces`,
    trace: (traceId: string) => `${base}/traces?trace=${traceId}`,
    datasets: `${base}/datasets`,
    dataset: (datasetId: string) => `${base}/datasets/${datasetId}`,
    experiments: `${base}/experiments`,
    newExperiment: `${base}/experiments/new`,
    experiment: (experimentId: string) => `${base}/experiments/${experimentId}`,
    compare: (candidateId: string, baselineId: string) =>
      `${base}/experiments/compare?candidate=${candidateId}&baseline=${baselineId}`,
    scorers: `${base}/scorers`,
    scorer: (scorerId: string) => `${base}/scorers/${scorerId}`,
    gates: `${base}/ci-gates`,
    gate: (gateId: string) => `${base}/ci-gates?gate=${gateId}`,
  };
}

export const SEVERITY_VARIANT: Record<Severity, "danger" | "warning" | "default"> = {
  high: "danger",
  medium: "warning",
  low: "default",
};

export const GOLDEN_VARIANT: Record<GoldenStatus, "success" | "warning" | "default"> = {
  golden: "success",
  needs_review: "warning",
  draft: "default",
};

export const OUTCOME_LABEL: Record<RowOutcome, string> = {
  improved: "Improved",
  regressed: "Regressed",
  unchanged: "Unchanged",
  needs_review: "Needs review",
};

export const OUTCOME_VARIANT: Record<RowOutcome, "success" | "danger" | "default" | "warning"> = {
  improved: "success",
  regressed: "danger",
  unchanged: "default",
  needs_review: "warning",
};

/** Formats a percentage for display, e.g. 93.8 → "93.8%". */
export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Formats a signed delta, e.g. 22.4 → "+22.4%", -1.6 → "−1.6%". */
export function signedPct(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/** Formats a signed millisecond delta, e.g. 80 → "+80ms". */
export function signedMs(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString()}ms`;
}

/** Renders a per-case score as a percentage or a pass/fail glyph. */
export function scoreDisplay(value: number | null): string {
  if (value === null) return "—";
  if (value === 0 || value === 1) return value === 1 ? "Pass" : "Fail";
  return `${(value * 100).toFixed(0)}%`;
}

/**
 * Reads a delta the way the user should, not by arithmetic sign: for a
 * lower-is-better metric a negative delta is good.
 */
export function deltaSentiment(
  delta: number,
  direction: "higher_is_better" | "lower_is_better",
): "good" | "bad" | "neutral" {
  if (delta === 0) return "neutral";
  const isUp = delta > 0;
  const good = direction === "higher_is_better" ? isUp : !isUp;
  return good ? "good" : "bad";
}

export const SENTIMENT_CLASS: Record<"good" | "bad" | "neutral", string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};

/** Compact absolute timestamp — the fixtures are fixed instants, not relative. */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function truncate(text: string, max = 72): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
