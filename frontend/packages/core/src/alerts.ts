// Shared alert vocabulary: the API routes, the list UI, the New Alert form and
// the evaluation worker all read it, so a rule saved by one is the same rule to
// the others.

import { ALERT_WINDOWS, type AlertWindow } from "./constants.ts";

export const ALERT_VIEWS = ["SPANS"] as const;
export type AlertView = (typeof ALERT_VIEWS)[number];
export const DEFAULT_ALERT_VIEW: AlertView = "SPANS";

export function isAlertView(value: string): value is AlertView {
  return (ALERT_VIEWS as readonly string[]).includes(value);
}

// NO_DATA means the window produced no value to judge, which is not the same as
// a window that measured zero. Whether it notifies is the rule's own choice —
// see ALERT_NO_DATA_MODES.
export const ALERT_SEVERITIES = ["UNKNOWN", "OK", "ALERT", "NO_DATA"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const DEFAULT_ALERT_SEVERITY: AlertSeverity = "UNKNOWN";

export function isAlertSeverity(value: string): value is AlertSeverity {
  return (ALERT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * What a window that measured nothing means for this rule. HOLD reads a gap as
 * deciding nothing: the severity reads NO_DATA, nothing pages or clears, and
 * an outstanding page stays open across it. ZERO suits a measure whose absence
 * is itself a number — no rows is a count of zero — and puts that zero to the
 * threshold. NOTIFY is for a source whose silence is the incident: the gap
 * pages, and its return pages again.
 */
export const ALERT_NO_DATA_MODES = ["HOLD", "ZERO", "NOTIFY"] as const;
export type AlertNoDataMode = (typeof ALERT_NO_DATA_MODES)[number];
export const DEFAULT_ALERT_NO_DATA_MODE: AlertNoDataMode = "HOLD";

export function isAlertNoDataMode(value: string): value is AlertNoDataMode {
  return (ALERT_NO_DATA_MODES as readonly string[]).includes(value);
}

/**
 * PARKED is terminal and the evaluator's alone: it means the stored rule cannot
 * be evaluated by the running build at all, so retrying it every minute only
 * burns a claim and leaves the owner reading a severity no run will ever move.
 * It leaves the claim query the same way PAUSED does, and an edit re-arms it.
 */
export const ALERT_STATUSES = ["ACTIVE", "PAUSED", "PARKED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const DEFAULT_ALERT_STATUS: AlertStatus = "ACTIVE";

export function isAlertStatus(value: string): value is AlertStatus {
  return (ALERT_STATUSES as readonly string[]).includes(value);
}

/**
 * What a client may ask for. Parking is a verdict about the stored rule, not a
 * preference, so it is reached by failing evaluation and left by fixing the rule.
 */
export const SETTABLE_ALERT_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type SettableAlertStatus = (typeof SETTABLE_ALERT_STATUSES)[number];

export function isSettableAlertStatus(value: string): value is SettableAlertStatus {
  return (SETTABLE_ALERT_STATUSES as readonly string[]).includes(value);
}

/** Statuses the scheduler does not claim, and that a resume cold-starts from. */
export const STOPPED_ALERT_STATUSES: readonly AlertStatus[] = ["PAUSED", "PARKED"];

export const ALERT_THRESHOLD_OPERATORS = [">", ">=", "<", "<=", "=", "!="] as const;
export type AlertThresholdOperator = (typeof ALERT_THRESHOLD_OPERATORS)[number];

export function isAlertThresholdOperator(value: string): value is AlertThresholdOperator {
  return (ALERT_THRESHOLD_OPERATORS as readonly string[]).includes(value);
}

// Two spellings on purpose: LABELS read as standalone dropdown options,
// PHRASES read mid-sentence in a notification ("was 12, at or above the 10
// threshold"). One map would make the other surface read badly.
export const ALERT_THRESHOLD_OPERATOR_LABELS: Record<AlertThresholdOperator, string> = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  "=": "=",
  "!=": "≠",
};

export const ALERT_THRESHOLD_OPERATOR_PHRASES: Record<AlertThresholdOperator, string> = {
  ">": "above",
  ">=": "at or above",
  "<": "below",
  "<=": "at or below",
  "=": "equal to",
  "!=": "not equal to",
};

export const ALERT_AGGREGATIONS = [
  "sum",
  "avg",
  "count",
  "max",
  "min",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "uniq",
] as const;
export type AlertAggregation = (typeof ALERT_AGGREGATIONS)[number];

export function isAlertAggregation(value: string): value is AlertAggregation {
  return (ALERT_AGGREGATIONS as readonly string[]).includes(value);
}

export const ALERT_NAME_MAX: number = 200;

/**
 * Whether a sustained breach keeps speaking. A discriminated union rather than
 * a nullable number so "off" cannot carry a stale interval.
 */
export type AlertRenotify = { mode: "OFF" } | { mode: "EVERY"; intervalMinutes: number };

export const ALERT_RENOTIFY_MIN_MINUTES: number = 1;
export const ALERT_RENOTIFY_MAX_MINUTES: number = 60 * 24 * 7;
export const DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES: number = 60;

export const DEFAULT_ALERT_RENOTIFY: AlertRenotify = { mode: "OFF" };

/** Any number — blank, fractional, out of range — lands on a legal interval. */
export function clampRenotifyInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES;
  return Math.min(
    ALERT_RENOTIFY_MAX_MINUTES,
    Math.max(ALERT_RENOTIFY_MIN_MINUTES, Math.trunc(minutes)),
  );
}

/**
 * Every field an alert can filter on is a string dimension, so these two are the
 * whole vocabulary. The evaluator validates the batch against the field
 * registry, so an operator no field declares fails every alert in the request.
 */
export const ALERT_FILTER_OPERATORS = ["=", "contains"] as const;
export type AlertFilterOperator = (typeof ALERT_FILTER_OPERATORS)[number];

export function isAlertFilterOperator(value: string): value is AlertFilterOperator {
  return (ALERT_FILTER_OPERATORS as readonly string[]).includes(value);
}

/**
 * In the order the field dropdown lists them. Widget-engine field names, not
 * alert measure ids, and every one a row-level predicate on `spans`: the
 * trace-list registry's `SPAN_AGGREGATE` fields have no span-grain meaning.
 */
export const ALERT_FILTER_FIELDS = [
  "model_name",
  "environment",
  "status",
  "span_kind",
  "name",
  "is_root",
  "metadata",
] as const;
export type AlertFilterField = (typeof ALERT_FILTER_FIELDS)[number];

export function isAlertFilterField(value: string): value is AlertFilterField {
  return (ALERT_FILTER_FIELDS as readonly string[]).includes(value);
}

/** Mirrors `filter_ops` in backend/rest/services/widget_registry.py. */
export const ALERT_FILTER_OPERATORS_BY_FIELD: Record<
  AlertFilterField,
  readonly AlertFilterOperator[]
> = {
  model_name: ALERT_FILTER_OPERATORS,
  environment: ALERT_FILTER_OPERATORS,
  status: ALERT_FILTER_OPERATORS,
  span_kind: ALERT_FILTER_OPERATORS,
  name: ALERT_FILTER_OPERATORS,
  is_root: ["="],
  metadata: ALERT_FILTER_OPERATORS,
};

/**
 * Fields whose predicate names a map entry, so a row on one is only a predicate
 * once it also carries a key. Mirrors `requiresKey` in the engine's live schema.
 */
export const KEYED_ALERT_FILTER_FIELDS: readonly string[] = ["metadata"];

/** Scalar only: the engine has no set operator, so an array is unevaluable. */
export type AlertFilterValue = string | number;

/** `key` is set only on a keyed field (metadata). */
export interface AlertFilter {
  field: string;
  key?: string;
  op: string;
  value: AlertFilterValue;
}

/**
 * A half-filled row is neither previewed nor saved and a complete one must reach
 * both, or the chart describes a different query from the alert. A keyless
 * metadata row is not "metadata, any key".
 */
export function isCompleteAlertFilter(filter: AlertFilter): boolean {
  if (filter.field === "" || filter.op === "" || String(filter.value) === "") return false;
  if (!KEYED_ALERT_FILTER_FIELDS.includes(filter.field)) return true;
  return (filter.key ?? "").trim() !== "";
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Filters are stored canonicalized so two rules expressing the same predicate
 * set serialize identically; otherwise a fingerprint over the stored JSON would
 * differ purely by the order the user added rows in.
 */
export function canonicalizeAlertFilters(filters: readonly AlertFilter[]): AlertFilter[] {
  const canonical = filters.map((filter): AlertFilter => {
    // Fixed key order so JSON.stringify of the result is itself canonical.
    return filter.key === undefined
      ? { field: filter.field, op: filter.op, value: filter.value }
      : { field: filter.field, key: filter.key, op: filter.op, value: filter.value };
  });

  return canonical.sort(
    (a, b) =>
      compareText(a.field, b.field) ||
      compareText(a.op, b.op) ||
      compareText(a.key ?? "", b.key ?? "") ||
      compareText(JSON.stringify(a.value), JSON.stringify(b.value)),
  );
}

// "count" is the row-count pseudo-measure: it reads no column, so `count` is
// the only aggregation that means anything on it.
export type AlertMeasureType = "number" | "string" | "count";

export interface AlertMeasure {
  id: string;
  label: string;
  type: AlertMeasureType;
}

export const ALERT_MEASURES_BY_VIEW: Record<AlertView, readonly AlertMeasure[]> = {
  SPANS: [
    { id: "count", label: "Count", type: "count" },
    { id: "trace_id", label: "Trace ID", type: "string" },
    { id: "latency", label: "Latency", type: "number" },
    { id: "cost", label: "Cost", type: "number" },
    { id: "input_tokens", label: "Input tokens", type: "number" },
    { id: "output_tokens", label: "Output tokens", type: "number" },
    { id: "total_tokens", label: "Total tokens", type: "number" },
    { id: "total_tokens_per_second", label: "Total tokens per second", type: "number" },
    { id: "unique_user_ids", label: "Unique user ids", type: "string" },
    { id: "unique_session_ids", label: "Unique session ids", type: "string" },
  ],
};

export function getMeasure(view: AlertView, measureId: string): AlertMeasure | undefined {
  return ALERT_MEASURES_BY_VIEW[view].find((m) => m.id === measureId);
}

/** The query-engine view and field that compute a measure. */
export interface AlertMetricSource {
  readonly view: "spans" | "traces";
  readonly field: string;
}

// Counterpart of `_WIDGET_SOURCE_BY_ALERT_MEASURE` in
// backend/rest/services/alert_evaluation.py: the evaluated number must be the
// previewed number, so the two tables move together. The unique-id measures
// read `traces`, where their columns live; an unfiltered distinct count is the
// same number at either grain.
const SOURCE_BY_ALERT_MEASURE: Record<string, AlertMetricSource> = {
  count: { view: "spans", field: "count" },
  trace_id: { view: "spans", field: "trace_id" },
  latency: { view: "spans", field: "duration_ms" },
  cost: { view: "spans", field: "cost" },
  input_tokens: { view: "spans", field: "input_tokens" },
  output_tokens: { view: "spans", field: "output_tokens" },
  total_tokens: { view: "spans", field: "total_tokens" },
  total_tokens_per_second: { view: "spans", field: "tokens_per_second" },
  unique_user_ids: { view: "traces", field: "user_id" },
  unique_session_ids: { view: "traces", field: "session_id" },
};

// The engine's AGGS_NUMBER. `count` is absent because the engine reserves it
// for the count(*) sentinel, and count(column) is not that query.
const ENGINE_NUMBER_AGGREGATIONS: readonly AlertAggregation[] = [
  "sum",
  "avg",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "uniq",
];

function isRunnableAggregation(type: AlertMeasureType, aggregation: AlertAggregation): boolean {
  if (type === "count") return aggregation === "count";
  // Not count: count(user_id) tallies rows carrying the id, which reads as
  // "unique users" on a measure labelled that way. Row counting is the count measure's job.
  if (type === "string") return aggregation === "uniq";
  return ENGINE_NUMBER_AGGREGATIONS.includes(aggregation);
}

/**
 * Where this rule's number comes from, or null when the engine cannot express
 * it exactly: a `traces`-routed measure cannot carry span-grain filters, for
 * the reason stated on SOURCE_BY_ALERT_MEASURE above.
 */
export function resolveAlertMetricSource(
  view: AlertView,
  measureId: string,
  aggregation: AlertAggregation,
  filters: readonly AlertFilter[] = [],
): AlertMetricSource | null {
  if (view !== "SPANS") return null;
  const source = SOURCE_BY_ALERT_MEASURE[measureId];
  const measure = getMeasure(view, measureId);
  if (!source || !measure) return null;
  if (!isRunnableAggregation(measure.type, aggregation)) return null;
  if (source.view !== "spans" && filters.some(isCompleteAlertFilter)) return null;
  return source;
}

/**
 * A combination the engine refuses raises on every tick and never records a
 * severity, which is why the write gate refuses it and the form never offers it.
 */
export function isEvaluableAlertMetric(
  view: AlertView,
  measureId: string,
  aggregation: AlertAggregation,
  filters: readonly AlertFilter[] = [],
): boolean {
  return resolveAlertMetricSource(view, measureId, aggregation, filters) !== null;
}

/** The aggregations the dropdown offers: engine-runnable, not merely typable. */
export function getValidAggregations(
  measure: AlertMeasure,
  view: AlertView = DEFAULT_ALERT_VIEW,
): readonly AlertAggregation[] {
  return ALERT_AGGREGATIONS.filter((aggregation) =>
    isEvaluableAlertMetric(view, measure.id, aggregation),
  );
}

// Evaluated windows end this far behind the tick so a window is not judged
// while its spans are still arriving.
export const ALERT_EVALUATION_OFFSET_MS: number = 30_000;

export function windowToMs(window: AlertWindow): number {
  return ALERT_WINDOWS[window];
}
