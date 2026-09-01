import { z } from "zod";
import {
  ALERT_FILTER_OPERATORS,
  ALERT_FILTER_OPERATORS_BY_FIELD,
  ALERT_NAME_MAX,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
  ALERT_STATUSES,
  KEYED_ALERT_FILTER_FIELDS,
  getMeasure,
  isAlertAggregation,
  isAlertFilterField,
  isAlertNoDataMode,
  isAlertThresholdOperator,
  isAlertView,
  isAlertWindow,
  isEvaluableAlertMetric,
  type AlertFilter,
} from "@traceroot/core";

const FILTER_TOKEN_MAX = 128;
const FILTER_VALUE_MAX = 1024;
export const ALERT_FILTERS_MAX = 50;

// The threshold column is Decimal(65,30), so anything past 35 integer digits is
// a database error rather than a validation one.
export const THRESHOLD_ABS_MAX = 1e34;

// `op` and `value` are exactly `WidgetFilter` in
// backend/rest/schemas/dashboards.py. What that model refuses it refuses for
// the whole batch, so anything storable here but not sendable there silences
// every alert sharing its window.
const filterValueSchema = z.union([
  z.string().min(1).max(FILTER_VALUE_MAX),
  z.number().refine(Number.isFinite, "filter value must be a finite number"),
]);

// Strict: a misspelled `key` would otherwise silently store an unkeyed filter.
// A field, operator or key the engine does not declare is not a filter that
// matches nothing, it is a rule that raises on every tick while it is stored.
const filterSchema = z
  .strictObject({
    field: z.string().min(1).max(FILTER_TOKEN_MAX),
    // Trimmed before the length check: the evaluability gate reads a blank key
    // as "not a predicate yet" and waves the row through, while the engine
    // still sees a filter and refuses the rule on every tick.
    key: z.string().trim().min(1).max(FILTER_TOKEN_MAX).optional(),
    op: z.enum(ALERT_FILTER_OPERATORS),
    value: filterValueSchema,
  })
  .superRefine((filter, ctx) => {
    if (!isAlertFilterField(filter.field)) {
      ctx.addIssue({
        code: "custom",
        path: ["field"],
        message: `Alerts cannot filter on "${filter.field}"`,
      });
      return;
    }
    if (KEYED_ALERT_FILTER_FIELDS.includes(filter.field) && filter.key === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["key"],
        message: `Filter on "${filter.field}" requires a key`,
      });
    }
    if (!ALERT_FILTER_OPERATORS_BY_FIELD[filter.field].includes(filter.op)) {
      ctx.addIssue({
        code: "custom",
        path: ["op"],
        message: `Operator "${filter.op}" is not valid for "${filter.field}"`,
      });
    }
  });

// Strict on both arms: an interval alongside OFF is a contradiction, and
// stripping it would answer a request the caller did not make.
const renotifySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("OFF") }),
  z.strictObject({
    mode: z.literal("EVERY"),
    intervalMinutes: z
      .number()
      .int()
      .min(ALERT_RENOTIFY_MIN_MINUTES)
      .max(ALERT_RENOTIFY_MAX_MINUTES),
  }),
]);

const alertRuleShape = {
  name: z.string().trim().min(1, "name must be a non-empty string").max(ALERT_NAME_MAX),
  view: z.string().refine(isAlertView, "Invalid view"),
  measure: z.string().min(1, "measure must be a non-empty string").max(FILTER_TOKEN_MAX),
  aggregation: z.string().refine(isAlertAggregation, "Invalid aggregation"),
  filters: z.array(filterSchema).max(ALERT_FILTERS_MAX),
  window: z.string().refine(isAlertWindow, "Invalid window"),
  thresholdOperator: z.string().refine(isAlertThresholdOperator, "Invalid thresholdOperator"),
  threshold: z.number().gte(-THRESHOLD_ABS_MAX).lte(THRESHOLD_ABS_MAX),
  renotify: renotifySchema,
  // Optional on create as well as update: a caller with no opinion about gaps
  // takes the column default rather than having to name it.
  noDataMode: z.string().refine(isAlertNoDataMode, "Invalid noDataMode").optional(),
};

export const alertCreateSchema = z.object(alertRuleShape);
export const alertUpdateSchema = z.object(alertRuleShape).partial();
export const alertPauseSchema = z.object({ status: z.enum(ALERT_STATUSES) });

export type AlertCreateInput = z.infer<typeof alertCreateSchema>;
export type AlertUpdateInput = z.infer<typeof alertUpdateSchema>;
export type AlertPauseInput = z.infer<typeof alertPauseSchema>;

/** This repo's routes return the first issue's message, not Zod's tree. */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid request body";
}

/**
 * Measures are per-view, so the pair is only checkable once both are known —
 * on a PATCH that means after merging with the stored rule.
 */
export function isMeasureValidForView(view: string, measure: string): boolean {
  return isAlertView(view) && getMeasure(view, measure) !== undefined;
}

/**
 * Whether the combination is one the engine can actually run. Filters are part
 * of the question: they route the unique-id measures out of reach.
 */
export function isAggregationValidForMeasure(
  view: string,
  measure: string,
  aggregation: string,
  filters: readonly AlertFilter[] = [],
): boolean {
  if (!isAlertView(view) || !isAlertAggregation(aggregation)) return false;
  return isEvaluableAlertMetric(view, measure, aggregation, filters);
}

/**
 * The key is dropped on a field that takes none: the form's row editing leaves
 * one behind when the field changes away from a keyed one, and the engine
 * refuses a key it did not declare.
 */
export function toAlertFilters(filters: AlertCreateInput["filters"]): AlertFilter[] {
  return filters.map((filter) =>
    filter.key === undefined || !KEYED_ALERT_FILTER_FIELDS.includes(filter.field)
      ? { field: filter.field, op: filter.op, value: filter.value }
      : { field: filter.field, key: filter.key, op: filter.op, value: filter.value },
  );
}
