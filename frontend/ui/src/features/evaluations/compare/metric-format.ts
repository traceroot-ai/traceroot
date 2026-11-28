/**
 * How a metric column reads. Decided once per column, from every value the selected runs
 * recorded for it, so a column never switches units from row to row: a count that is 0 on
 * most cases and 2 on one reads "0" and "2", not "0.0%" and "2".
 */
import { pctFraction } from "@/features/offline-eval/utils";
import { formatCost as formatCostShown, formatDuration } from "@/lib/utils";

export type MetricFormat = { kind: "proportion" } | { kind: "number" };

/** A column whose every value is within [0,1] is a proportion; anything else is a plain
 *  number. A boolean column with no values yet is a proportion; one that stores other
 *  numbers is decided by them like a numeric column. */
export function inferMetricFormat(
  valueType: "numeric" | "boolean" | "categorical",
  values: readonly number[],
): MetricFormat {
  if (valueType === "categorical") return { kind: "number" };
  if (values.length === 0) return { kind: valueType === "boolean" ? "proportion" : "number" };
  return { kind: values.every((v) => v >= 0 && v <= 1) ? "proportion" : "number" };
}

// Two decimals at most, trailing zeros dropped, so float noise (4.1 - 3.1) reads "1".
const trimmed = (v: number) => String(Number(v.toFixed(2)));

/** 0.821 → "82.1%" as a proportion; 2 → "2", 0.25 → "0.25" as a number. */
export function formatMetricValue(value: number, format: MetricFormat): string {
  return format.kind === "proportion" ? pctFraction(value) : trimmed(value);
}

/** A signed change in the column's units: a proportion moves in percentage points
 *  (+0.036 → "+3.6 pp"), a number in itself (+0.25 → "+0.25"). A change that rounds to
 *  nothing carries no sign. */
export function formatMetricDelta(delta: number, format: MetricFormat): string {
  const shown =
    format.kind === "proportion" ? (Math.abs(delta) * 100).toFixed(1) : trimmed(Math.abs(delta));
  const sign = Number(shown) === 0 ? "" : delta > 0 ? "+" : "−";
  return format.kind === "proportion" ? `${sign}${shown} pp` : `${sign}${shown}`;
}

/** A latency, as durations read elsewhere in the app: 840 → "840ms", 2100 → "2.1s",
 *  65000 → "1m 5s". */
export const formatMs = (n: number) => formatDuration(n);

/** A cost, as costs read elsewhere in the app (0.0012 → "$0.0012", 0.01 → "$0.0100"), and
 *  a recorded zero as "$0". Rounded to a billionth of a dollar first, so the float noise
 *  left by subtracting two means reads as no change. */
export const formatCost = (n: number) => {
  const rounded = Math.round(n * 1e9) / 1e9;
  return rounded === 0 ? "$0" : formatCostShown(rounded);
};

/** A signed change in a unit formatter's own terms, e.g. +1.2s. A change that reads as
 *  nothing ("0ms", "$0") carries no sign, so it isn't coloured either. */
export const signedWith = (fmt: (n: number) => string) => (d: number) => {
  const shown = fmt(Math.abs(d));
  return shown === fmt(0) ? shown : `${d > 0 ? "+" : "−"}${shown}`;
};
