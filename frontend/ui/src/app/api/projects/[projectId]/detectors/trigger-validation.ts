type TriggerConditionPayload = {
  field: string;
  op: string;
  value: string | null;
};

const TRIGGER_FIELD_OPERATORS = new Map([["environment", new Set(["=", "!="])]]);

const LEGACY_TRIGGER_OPERATORS = new Map([
  ["eq", "="],
  ["ne", "!="],
  ["neq", "!="],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
]);

function isEnvironmentValue(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function hasOwn(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeOperator(op: string) {
  return LEGACY_TRIGGER_OPERATORS.get(op) ?? op;
}

export function normalizeTriggerConditions(
  triggerConditions: unknown,
): { conditions: TriggerConditionPayload[]; error: null } | { conditions: null; error: string } {
  if (!Array.isArray(triggerConditions)) {
    return { conditions: null, error: "triggerConditions must be an array" };
  }

  const normalized: TriggerConditionPayload[] = [];
  for (const [index, condition] of triggerConditions.entries()) {
    const prefix = `triggerConditions[${index}]`;
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
      return { conditions: null, error: `${prefix} must be an object` };
    }

    const record = condition as Record<string, unknown>;
    const field = hasOwn(record, "field") ? record.field : undefined;
    const op = hasOwn(record, "op") ? record.op : undefined;
    const value = hasOwn(record, "value") ? record.value : undefined;
    if (typeof field !== "string" || field.trim().length === 0) {
      return { conditions: null, error: `${prefix}.field must be a non-empty string` };
    }

    const fieldOperators = TRIGGER_FIELD_OPERATORS.get(field);
    if (fieldOperators === undefined) {
      return {
        conditions: null,
        error: `${prefix}.field must be one of environment`,
      };
    }

    const normalizedOp = typeof op === "string" ? normalizeOperator(op) : op;
    if (typeof normalizedOp !== "string" || !fieldOperators.has(normalizedOp)) {
      return {
        conditions: null,
        error: `${prefix}.op must be one of ${Array.from(fieldOperators).join(", ")} for ${field}`,
      };
    }

    if (!hasOwn(record, "value") || !isEnvironmentValue(value)) {
      return {
        conditions: null,
        error: `${prefix}.value must be a string or null for ${field}`,
      };
    }

    normalized.push({ field, op: normalizedOp, value });
  }

  return { conditions: normalized, error: null };
}
