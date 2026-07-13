/**
 * Offline Evaluation — helpers and route builders.
 */

import type { ResultStatus, ReviewStatus } from "./types";

/** v1 navigation: Traces, Datasets, Experiments, Scorers. Nothing else. */
export function evalRoutes(projectId: string) {
  const base = `/projects/${projectId}/offline-eval`;
  return {
    base,
    traces: `${base}/traces`,
    trace: (traceId: string) => `${base}/traces?trace=${traceId}`,
    datasets: `${base}/datasets`,
    dataset: (datasetId: string) => `${base}/datasets/${datasetId}`,
    experiments: `${base}/experiments`,
    experiment: (experimentId: string) => `${base}/experiments/${experimentId}`,
    scorers: `${base}/scorers`,
  };
}

/** Badge variants for the four status labels. Muted on purpose. */
export const RESULT_STATUS_VARIANT: Record<ResultStatus, "success" | "danger" | "warning"> = {
  passed: "success",
  failed: "danger",
  needs_review: "warning",
};

export const REVIEW_STATUS_VARIANT: Record<ReviewStatus, "success" | "warning"> = {
  golden: "success",
  needs_review: "warning",
};

/** e.g. 93.8 → "93.8%" */
export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** e.g. 22.4 → "+22.4", -9.5 → "−9.5" (true minus sign, not a hyphen). */
export function signed(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

/**
 * Reads a change the way a person would, not by arithmetic sign.
 * Everything in v1 is higher-is-better, but the direction stays explicit so a
 * lower-is-better metric can't silently render green for getting worse.
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

/** Compact absolute timestamp — the fixtures are fixed instants. */
export function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
