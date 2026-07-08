import { describe, expect, it } from "vitest";
import { normalizeTriggerConditions } from "./trigger-validation";

describe("normalizeTriggerConditions", () => {
  it("accepts empty trigger conditions", () => {
    expect(normalizeTriggerConditions([])).toEqual({ conditions: [], error: null });
  });

  it.each(["=", "!="])("accepts null values for environment %s comparisons", (op) => {
    expect(normalizeTriggerConditions([{ field: "environment", op, value: null }])).toEqual({
      conditions: [{ field: "environment", op, value: null }],
      error: null,
    });
  });

  it("normalizes legacy equality aliases", () => {
    expect(
      normalizeTriggerConditions([{ field: "environment", op: "eq", value: "production" }]),
    ).toEqual({
      conditions: [{ field: "environment", op: "=", value: "production" }],
      error: null,
    });
  });

  it("rejects unsupported fields that the worker summary cannot evaluate", () => {
    const result = normalizeTriggerConditions([{ field: "cost", op: ">", value: "10.5" }]);

    expect(result.error).toBe("triggerConditions[0].field must be one of environment");
  });

  it.each(["__proto__", "constructor", "toString"])("rejects prototype field name %s", (field) => {
    const result = normalizeTriggerConditions([{ field, op: "=", value: "production" }]);

    expect(result.error).toBe("triggerConditions[0].field must be one of environment");
  });

  it("rejects inherited condition fields", () => {
    const inheritedCondition = Object.create({
      field: "environment",
      op: "=",
      value: "production",
    }) as unknown;

    const result = normalizeTriggerConditions([inheritedCondition]);

    expect(result.error).toBe("triggerConditions[0].field must be a non-empty string");
  });

  it.each(["0x10", "0b10", "0o10"])("rejects numeric operators for environment (%s)", (value) => {
    const result = normalizeTriggerConditions([{ field: "environment", op: ">", value }]);

    expect(result.error).toBe("triggerConditions[0].op must be one of =, != for environment");
  });

  it.each([42, true, false, {}, []])("rejects non-string environment value %s", (value) => {
    const result = normalizeTriggerConditions([{ field: "environment", op: "=", value }]);

    expect(result.error).toBe(
      "triggerConditions[0].value must be a string or null for environment",
    );
  });

  it("rejects missing environment values with field-specific copy", () => {
    const result = normalizeTriggerConditions([{ field: "environment", op: "=" }]);

    expect(result.error).toBe(
      "triggerConditions[0].value must be a string or null for environment",
    );
  });

  it("returns the field-specific operator set for unknown operators", () => {
    const result = normalizeTriggerConditions([
      { field: "environment", op: "contains", value: "production" },
    ]);

    expect(result.error).toBe("triggerConditions[0].op must be one of =, != for environment");
  });
});
