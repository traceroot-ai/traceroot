// The vocabulary lives in `@traceroot/core` so the form, the API routes and the
// evaluation worker share one declaration. `ALERT_OPERATORS` is core's
// `ALERT_THRESHOLD_OPERATORS`, renamed now that no filter operator is in scope.

import type { AlertFilter, AlertNoDataMode } from "@traceroot/core";

export {
  ALERT_AGGREGATIONS,
  ALERT_FILTER_FIELDS,
  ALERT_MEASURES_BY_VIEW,
  ALERT_NAME_MAX,
  ALERT_NO_DATA_MODES,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
  ALERT_THRESHOLD_OPERATORS as ALERT_OPERATORS,
  ALERT_THRESHOLD_OPERATOR_LABELS as ALERT_OPERATOR_LABELS,
  ALERT_VIEWS,
  DEFAULT_ALERT_NO_DATA_MODE,
  DEFAULT_ALERT_RENOTIFY,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  DEFAULT_ALERT_VIEW,
  KEYED_ALERT_FILTER_FIELDS,
  clampRenotifyInterval,
  getMeasure,
  getValidAggregations,
  isCompleteAlertFilter,
  isEvaluableAlertMetric,
  resolveAlertMetricSource,
} from "@traceroot/core";
export type {
  AlertAggregation,
  AlertFilter,
  AlertMeasure,
  AlertMeasureType as MeasureType,
  AlertNoDataMode,
  AlertRenotify,
  AlertThresholdOperator as AlertOperator,
  AlertView,
} from "@traceroot/core";

/**
 * How each no-data mode reads in the form. HOLD shows NO_DATA and pages nothing,
 * ZERO compares an empty window as 0, NOTIFY pages NO_DATA and pages again when
 * data returns.
 */
export const ALERT_NO_DATA_MODE_LABELS: Readonly<Record<AlertNoDataMode, string>> = {
  HOLD: "Hold the last state",
  ZERO: "Treat as zero",
  NOTIFY: "Notify when data stops",
};

/** A fresh row: a field has to be picked before it can be a predicate. */
export const EMPTY_ALERT_FILTER: Readonly<AlertFilter> = Object.freeze({
  field: "",
  op: "",
  value: "",
});
