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
  { field: "model_name", label: "Model", ops: STRING_OPS, valueKind: "enum" },
  { field: "environment", label: "Environment", ops: STRING_OPS, valueKind: "enum" },
  { field: "cost", label: "Cost", ops: NUMERIC_OPS, valueKind: "number" },
  { field: "total_tokens", label: "Tokens", ops: NUMERIC_OPS, valueKind: "number", integer: true },
  { field: "duration_ms", label: "Latency", ops: NUMERIC_OPS, valueKind: "number", integer: true },
  { field: "errors", label: "Errors", ops: NUMERIC_OPS, valueKind: "number", integer: true },
  {
    field: "metadata",
    label: "Metadata",
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

/** Display label for an operator, matching the shared filter builders' vocabulary. */
export function triggerOpLabel(def: TriggerFieldDef | undefined, op: string): string {
  if (def?.valueKind === "number") return NUMERIC_OP_SYMBOL[op] ?? op;
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
