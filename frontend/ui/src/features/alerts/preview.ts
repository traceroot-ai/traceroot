// Maps an alert draft onto the dashboard widget query engine so the New Alert
// form can preview real project data.

import type { WidgetSpec } from "@/features/dashboards/types";
import {
  KEYED_ALERT_FILTER_FIELDS,
  getValidAggregations,
  isCompleteAlertFilter,
  resolveAlertMetricSource,
  type AlertAggregation,
  type AlertFilter,
  type AlertMeasure,
  type AlertView,
} from "./rule-model";

/**
 * Null when the engine cannot express the combination exactly. `key` stays
 * `undefined` rather than an empty string on unkeyed fields: the engine rejects
 * a key on a field that takes none, and JSON omits undefined.
 */
export function buildPreviewSpec(
  view: AlertView,
  measureId: string,
  aggregation: AlertAggregation,
  filters: readonly AlertFilter[] = [],
): WidgetSpec | null {
  const source = resolveAlertMetricSource(view, measureId, aggregation, filters);
  if (!source) return null;
  return {
    view: source.view,
    filters: filters.filter(isCompleteAlertFilter).map((f) => ({
      field: f.field,
      op: f.op as WidgetSpec["filters"][number]["op"],
      value: f.value,
      key: KEYED_ALERT_FILTER_FIELDS.includes(f.field) ? f.key?.trim() || undefined : undefined,
    })),
    metric: { measure: source.field, agg: aggregation as WidgetSpec["metric"]["agg"] },
    breakdown: null,
    display: { type: "line" },
  };
}

const PREFERRED_AGGREGATION: Record<AlertMeasure["type"], AlertAggregation> = {
  number: "avg",
  string: "uniq",
  count: "count",
};

/**
 * A numeric measure keeps the current aggregation when it is still valid, so
 * switching cost to latency keeps p95; an id measure always lands on uniq,
 * because `count` of an id column is row count.
 */
export function nextAggregationForMeasure(
  view: AlertView,
  measure: AlertMeasure,
  current: AlertAggregation,
): AlertAggregation {
  const valid = getValidAggregations(measure, view);
  if (valid.includes(current) && (measure.type !== "string" || current === "uniq")) return current;
  const preferred = PREFERRED_AGGREGATION[measure.type];
  return valid.includes(preferred) ? preferred : valid[0];
}

/** The window the filter rows enumerate stored values over. */
export const FILTER_VALUE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function parseThreshold(threshold: string): number | null {
  if (threshold.trim() === "") return null;
  const value = Number(threshold);
  return Number.isFinite(value) ? value : null;
}
