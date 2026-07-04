import { describe, it, expect } from "vitest";
import { STATIC_FILTER_FIELDS } from "./registry";

describe("STATIC_FILTER_FIELDS fallback", () => {
  it("covers the trace + membership + aggregate tiers", () => {
    expect(STATIC_FILTER_FIELDS.map((f) => f.field).sort()).toEqual(
      [
        "cost",
        "duration_ms",
        "environment",
        "errors",
        "model_name",
        "total_tokens",
        "trace_id",
      ].sort(),
    );
  });

  it("declares the right operator set per field type", () => {
    for (const f of STATIC_FILTER_FIELDS) {
      if (f.type === "categorical") expect(f.operators).toEqual(["in"]);
      else if (f.type === "numeric") expect(f.operators).toEqual(["eq", "gt", "gte", "lt", "lte"]);
      else if (f.type === "text") expect(f.operators).toEqual(["eq", "contains"]);
    }
  });

  it("distinct-query categorical fields carry no static values", () => {
    const model = STATIC_FILTER_FIELDS.find((f) => f.field === "model_name")!;
    expect(model.value_source).toBe("distinct_query");
    expect(model.enum_values).toEqual([]);
  });
});
