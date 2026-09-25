import { describe, it, expect } from "vitest";
import { MAX_FILTERS } from "@/features/filters/predicate";
import {
  TRIGGER_FIELD_DEFS,
  defaultTriggerCondition,
  normalizeTriggerConditions,
  validateTriggerConditions,
} from "./trigger-fields";

/**
 * The registry is the write path's whitelist: a condition the worker cannot
 * evaluate has to be refused here, at save time, rather than stored and then
 * silently never matched at evaluation time.
 */

/** One valid condition per offered field, in registry order. */
const VALID_CONDITIONS = [
  { field: "model_name", op: "=", value: "gpt-4" },
  { field: "environment", op: "!=", value: "prod" },
  { field: "cost", op: ">", value: 0.25 },
  { field: "total_tokens", op: ">=", value: 1200 },
  { field: "duration_ms", op: "<", value: 4500 },
  { field: "errors", op: "=", value: 0 },
  { field: "metadata", op: "contains", value: "acme", key: "tenant" },
];

describe("validateTriggerConditions — what the write path accepts", () => {
  it("accepts one condition on every offered field", () => {
    expect(VALID_CONDITIONS.map((c) => c.field)).toEqual(TRIGGER_FIELD_DEFS.map((d) => d.field));
    expect(validateTriggerConditions(VALID_CONDITIONS)).toBeNull();
  });

  it("accepts none through the filter cap, and refuses past it", () => {
    // No conditions is valid: the detector then runs on every completed trace.
    expect(validateTriggerConditions([])).toBeNull();
    const overCap = Array.from({ length: MAX_FILTERS + 1 }, () => VALID_CONDITIONS[0]);
    expect(validateTriggerConditions(overCap.slice(0, MAX_FILTERS))).toBeNull();
    expect(validateTriggerConditions(overCap)).not.toBeNull();
  });
});

describe("validateTriggerConditions — fields and operators the evaluator cannot run", () => {
  it("refuses a field that is not offered, including the deliberately excluded trace id", () => {
    expect(
      validateTriggerConditions([{ field: "status", op: "=", value: "ERROR" }]),
    ).not.toBeNull();
    expect(
      validateTriggerConditions([{ field: "trace_id", op: "=", value: "abc" }]),
    ).not.toBeNull();
    expect(TRIGGER_FIELD_DEFS.some((d) => d.field === "trace_id")).toBe(false);
  });

  it("refuses an operator the field does not offer", () => {
    // Ordering on a membership field, and inequality on a numeric aggregate:
    // both are operators the trace list does not offer for that field either.
    expect(validateTriggerConditions([{ field: "environment", op: ">", value: "prod" }])).toContain(
      "Environment",
    );
    expect(validateTriggerConditions([{ field: "cost", op: "!=", value: 1 }])).toContain("Cost");
  });
});

describe("validateTriggerConditions — value shapes", () => {
  it("refuses the empty value a half-filled row carries, so Save stays blocked", () => {
    // The trigger editor stores "" for an untouched value, and a legacy row can
    // hold one already; either would evaluate against nothing.
    expect(validateTriggerConditions([defaultTriggerCondition("model_name")])).not.toBeNull();
    expect(validateTriggerConditions([defaultTriggerCondition("cost")])).not.toBeNull();
    expect(validateTriggerConditions([{ field: "cost", op: ">", value: "0.25" }])).not.toBeNull();
  });

  it("refuses a fractional or negative value on a whole-number field", () => {
    expect(validateTriggerConditions([{ field: "errors", op: ">", value: 1.5 }])).not.toBeNull();
    expect(
      validateTriggerConditions([{ field: "total_tokens", op: ">", value: -1 }]),
    ).not.toBeNull();
    expect(validateTriggerConditions([{ field: "cost", op: ">", value: 0.5 }])).toBeNull();
  });

  it("requires a metadata key, and refuses one on every other field", () => {
    const metadata = { field: "metadata", op: "=", value: "acme" };
    expect(validateTriggerConditions([metadata])).not.toBeNull();
    expect(validateTriggerConditions([{ ...metadata, key: "" }])).not.toBeNull();
    expect(validateTriggerConditions([{ ...metadata, key: "tenant" }])).toBeNull();
    expect(
      validateTriggerConditions([{ field: "environment", op: "=", value: "prod", key: "tenant" }]),
    ).not.toBeNull();
  });

  it("refuses a payload that is not an array of objects", () => {
    expect(validateTriggerConditions({ field: "cost", op: ">", value: 1 })).not.toBeNull();
    expect(validateTriggerConditions([null])).not.toBeNull();
    expect(validateTriggerConditions(["environment=prod"])).not.toBeNull();
  });
});

describe("normalizeTriggerConditions — the editor's rows as the write path stores them", () => {
  it("strips the whitespace around a metadata key", () => {
    expect(
      normalizeTriggerConditions([{ field: "metadata", op: "=", value: "acme", key: " tenant " }]),
    ).toEqual([{ field: "metadata", op: "=", value: "acme", key: "tenant" }]);
  });

  it("leaves a whitespace-only metadata key blocking the save", () => {
    // A key of one space matched nothing forever, because validation saw a
    // non-empty string and let it through.
    const blank = normalizeTriggerConditions([
      { field: "metadata", op: "=", value: "acme", key: " " },
    ]);
    expect(blank[0].key).toBe("");
    expect(validateTriggerConditions(blank)).not.toBeNull();
  });

  it("turns a typed numeric value into the number the write path requires", () => {
    const typed = [
      { field: "cost", op: ">", value: "0.25" },
      { field: "total_tokens", op: ">=", value: "1200" },
    ];
    expect(normalizeTriggerConditions(typed)).toEqual([
      { field: "cost", op: ">", value: 0.25 },
      { field: "total_tokens", op: ">=", value: 1200 },
    ]);
    expect(validateTriggerConditions(normalizeTriggerConditions(typed))).toBeNull();
  });

  it("keeps a long digit string exact rather than rounding it through the input", () => {
    const long = normalizeTriggerConditions([{ field: "cost", op: ">", value: "22222222222" }]);
    expect(long[0].value).toBe(22222222222);
  });

  it("leaves a text field's digits as the string it stores", () => {
    expect(
      normalizeTriggerConditions([{ field: "metadata", op: "=", value: "42", key: "tenant" }]),
    ).toEqual([{ field: "metadata", op: "=", value: "42", key: "tenant" }]);
  });

  it("leaves an untouched numeric row empty so the save stays blocked", () => {
    const untouched = normalizeTriggerConditions([defaultTriggerCondition("cost")]);
    expect(untouched[0].value).toBe("");
    expect(validateTriggerConditions(untouched)).not.toBeNull();
  });
});

describe("validateTriggerConditions — agreeing with what the write path receives", () => {
  it("passes a numeric value that is only valid once normalized", () => {
    const typed = [{ field: "cost", op: ">", value: "0.25" }];
    expect(validateTriggerConditions(typed)).not.toBeNull();
    expect(validateTriggerConditions(normalizeTriggerConditions(typed))).toBeNull();
  });

  it("refuses a non-numeric entry that normalization cannot rescue", () => {
    const typed = [{ field: "cost", op: ">", value: "abc" }];
    expect(normalizeTriggerConditions(typed)[0].value).toBeNaN();
    expect(validateTriggerConditions(normalizeTriggerConditions(typed))).not.toBeNull();
  });

  it("refuses a metadata key that is only whitespace, normalized or not", () => {
    const typed = [{ field: "metadata", op: "=", value: "acme", key: " " }];
    expect(validateTriggerConditions(typed)).not.toBeNull();
    expect(validateTriggerConditions(normalizeTriggerConditions(typed))).not.toBeNull();
  });
});
