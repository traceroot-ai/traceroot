/**
 * Detector trigger-condition field registry — the single source of truth for which
 * fields a detector filter may name, which operators each takes, and what a valid
 * condition looks like. The trigger editor renders from it and the detector API
 * routes validate against it, so a field cannot appear in the UI without the write
 * path accepting it.
 *
 * Fields and grain mirror the trace-list filter registry
 * (backend/rest/services/filters/columns.py); the evaluator in
 * backend/worker/detector_tasks.py fetches each field at that same grain. Operators
 * are the detector's stored vocabulary (symbolic: "=", ">", ...) — the same one the
 * dashboard widget filters use — rather than the trace list's wire names (eq/gt/...),
 * because that is what existing DetectorTrigger rows already hold.
 *
 * Trace ID is deliberately absent: detectors evaluate live traces as they complete,
 * so pinning one to a single known trace id is not a meaningful trigger.
 */

import { MAX_FILTERS, MAX_KEY_LENGTH, MAX_VALUE_LENGTH } from "@/features/filters/predicate";
import type { MessageKey } from "@/lib/i18n/messages/en";
import type { Translate } from "@/lib/i18n/translate";

export interface TriggerCondition {
  field: string;
  op: string;
  value: unknown;
  /** Map key for keyed fields (metadata). Absent for every other field. */
  key?: string;
}

export interface TriggerFieldDef {
  field: string;
  label: string;
  /** The label in the visitor's language; `label` stays English for API error messages. */
  labelKey: MessageKey;
  ops: readonly string[];
  /** enum: observed-values dropdown; number: numeric input; text: free text. */
  valueKind: "enum" | "number" | "text";
  integer?: boolean;
  requiresKey?: boolean;
}

const STRING_OPS = ["=", "!="] as const;
const NUMERIC_OPS = [">", ">=", "<", "<=", "="] as const;
const METADATA_OPS = ["=", "contains"] as const;

export const TRIGGER_FIELD_DEFS: readonly TriggerFieldDef[] = [
  {
    field: "model_name",
    label: "Model",
    labelKey: "detectorsFilter.fieldModel",
    ops: STRING_OPS,
    valueKind: "enum",
  },
  {
    field: "environment",
    label: "Environment",
    labelKey: "detectorsFilter.fieldEnvironment",
    ops: STRING_OPS,
    valueKind: "enum",
  },
  {
    field: "cost",
    label: "Cost",
    labelKey: "detectorsFilter.fieldCost",
    ops: NUMERIC_OPS,
    valueKind: "number",
  },
  {
    field: "total_tokens",
    label: "Tokens",
    labelKey: "detectorsFilter.fieldTokens",
    ops: NUMERIC_OPS,
    valueKind: "number",
    integer: true,
  },
  {
    field: "duration_ms",
    label: "Latency",
    labelKey: "detectorsFilter.fieldLatency",
    ops: NUMERIC_OPS,
    valueKind: "number",
    integer: true,
  },
  {
    field: "errors",
    label: "Errors",
    labelKey: "detectorsFilter.fieldErrors",
    ops: NUMERIC_OPS,
    valueKind: "number",
    integer: true,
  },
  {
    field: "metadata",
    label: "Metadata",
    labelKey: "detectorsFilter.fieldMetadata",
    ops: METADATA_OPS,
    valueKind: "text",
    requiresKey: true,
  },
];

const DEFS_BY_FIELD: Record<string, TriggerFieldDef> = Object.fromEntries(
  TRIGGER_FIELD_DEFS.map((d) => [d.field, d]),
);

export function triggerFieldDef(field: string): TriggerFieldDef | undefined {
  return DEFS_BY_FIELD[field];
}

export function defaultTriggerCondition(field: string): TriggerCondition {
  const def = DEFS_BY_FIELD[field] ?? TRIGGER_FIELD_DEFS[0];
  return {
    field: def.field,
    op: def.ops[0],
    value: "",
    ...(def.requiresKey ? { key: "" } : {}),
  };
}

/**
 * Editor rows as the write path stores them. The editor holds what was typed;
 * this is the one place it becomes a payload, mirroring the trace-list builder,
 * which also trims the metadata key only when it builds a predicate.
 */
export function normalizeTriggerConditions(conditions: TriggerCondition[]): TriggerCondition[] {
  return conditions.map((c) => {
    const def = DEFS_BY_FIELD[c.field];
    const value =
      def?.valueKind === "number" && typeof c.value === "string" && c.value.trim() !== ""
        ? Number(c.value)
        : c.value;
    return typeof c.key === "string" ? { ...c, value, key: c.key.trim() } : { ...c, value };
  });
}

const NUMERIC_OP_SYMBOL: Record<string, string> = { ">=": "≥", "<=": "≤" };
const STRING_OP_LABEL: Record<string, string> = { "=": "is", "!=": "is not" };
const STRING_OP_LABEL_KEY: Record<string, MessageKey> = {
  "=": "detectorsFilter.opIs",
  "!=": "detectorsFilter.opIsNot",
  contains: "detectorsFilter.opContains",
};

/**
 * Display label for an operator, matching the shared filter builders' vocabulary.
 * With `t` the label is in the visitor's language; without it, English.
 */
export function triggerOpLabel(
  def: TriggerFieldDef | undefined,
  op: string,
  t?: Translate,
): string {
  if (def?.valueKind === "number") return NUMERIC_OP_SYMBOL[op] ?? op;
  const key = STRING_OP_LABEL_KEY[op];
  if (t && key) return t(key);
  return STRING_OP_LABEL[op] ?? op;
}

function conditionError(item: unknown, index: number): string | null {
  const at = `condition ${index + 1}`;
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return `${at} must be an object`;
  }
  const { field, op, value, key } = item as Record<string, unknown>;
  const def = typeof field === "string" ? DEFS_BY_FIELD[field] : undefined;
  if (!def) return `${at} has an unknown field`;
  if (typeof op !== "string" || !def.ops.includes(op)) {
    return `${at} has an invalid operator for ${def.label}`;
  }
  if (def.requiresKey) {
    const trimmedKey = typeof key === "string" ? key.trim() : "";
    if (trimmedKey.length === 0) return `${at} requires a metadata key`;
    if (trimmedKey.length > MAX_KEY_LENGTH) return `${at} key is too long`;
  } else if (key !== undefined) {
    return `${at} does not take a key`;
  }
  if (def.valueKind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${at} requires a non-negative number`;
    }
    if (def.integer && !Number.isInteger(value)) return `${at} requires a whole number`;
  } else {
    if (typeof value !== "string" || value.length === 0) {
      return `${at} requires a non-empty value`;
    }
    if (value.length > MAX_VALUE_LENGTH) return `${at} value is too long`;
  }
  return null;
}

/**
 * Validate a trigger-conditions payload at the boundary. Returns the first
 * problem as a human-readable message, or null when the payload is valid.
 * An empty array is valid — it means the detector runs on all completed traces.
 */
export function validateTriggerConditions(conditions: unknown): string | null {
  if (!Array.isArray(conditions)) return "triggerConditions must be an array";
  if (conditions.length > MAX_FILTERS) {
    return `triggerConditions carries more than the maximum of ${MAX_FILTERS} conditions`;
  }
  for (let i = 0; i < conditions.length; i++) {
    const error = conditionError(conditions[i], i);
    if (error) return error;
  }
  return null;
}

// The validation messages are written once in English, because the API routes return them too.
// The form maps the ones a filter row can produce to keys when it shows them.
const CONDITION_ERROR_KEYS: Record<string, MessageKey> = {
  "has an unknown field": "detectorsFilter.errUnknownField",
  "requires a metadata key": "detectorsFilter.errNeedsKey",
  "key is too long": "detectorsFilter.errKeyTooLong",
  "does not take a key": "detectorsFilter.errNoKey",
  "requires a non-negative number": "detectorsFilter.errNeedsNumber",
  "requires a whole number": "detectorsFilter.errNeedsInteger",
  "requires a non-empty value": "detectorsFilter.errNeedsValue",
  "value is too long": "detectorsFilter.errValueTooLong",
};
const INVALID_OPERATOR = "has an invalid operator for ";

/** A `validateTriggerConditions` message in the visitor's language; unknown ones pass through. */
export function translateTriggerError(t: Translate, message: string | null): string | null {
  if (!message) return message;
  const match = /^condition (\d+) (.+)$/.exec(message);
  if (!match) return message;
  const [, n, problem] = match;
  if (problem.startsWith(INVALID_OPERATOR)) {
    const label = problem.slice(INVALID_OPERATOR.length);
    const def = TRIGGER_FIELD_DEFS.find((d) => d.label === label);
    return t("detectorsFilter.errInvalidOperator", { n, field: def ? t(def.labelKey) : label });
  }
  const key = CONDITION_ERROR_KEYS[problem];
  return key ? t(key, { n }) : message;
}
