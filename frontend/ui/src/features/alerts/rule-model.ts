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
 * How each no-data mode reads in the form.
 *
 * The labels state what the rule *shows*, because that is what the severity
 * actually becomes: `deriveAlertSeverity` returns NO_DATA for every mode except
 * ZERO. HOLD does not hold ALERT or OK across the gap — all that survives is an
 * open breach's renotify clock — so a label promising the previous state would
 * describe behaviour the evaluator does not have.
 */
export const ALERT_NO_DATA_MODE_LABELS: Readonly<Record<AlertNoDataMode, string>> = {
  HOLD: "Show no data, don't notify",
  ZERO: "Treat as zero",
  NOTIFY: "Notify when data stops",
};

/**
 * The consequence of each mode, shown under the select. Without this the modes
 * read as three flavours of the same thing, and NOTIFY's debounce — it pages only
 * once the gap outlasts the rule's own window — is invisible until it surprises
 * someone.
 */
export const ALERT_NO_DATA_MODE_HINTS: Readonly<Record<AlertNoDataMode, string>> = {
  HOLD: "The rule reads NO_DATA. Nothing pages and nothing clears; an alert already open keeps its renotify clock.",
  ZERO: "An empty window counts as 0, so the threshold still decides and NO_DATA never arises.",
  NOTIFY:
    "Pages when the gap has lasted the shorter of the rule's window or 10 minutes, and pages again when data returns.",
};

/** A fresh row: a field has to be picked before it can be a predicate. */
export const EMPTY_ALERT_FILTER: Readonly<AlertFilter> = Object.freeze({
  field: "",
  op: "",
  value: "",
});
