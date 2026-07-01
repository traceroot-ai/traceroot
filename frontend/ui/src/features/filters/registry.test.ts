import { describe, it, expect } from "vitest";
import { STATIC_FILTER_FIELDS } from "./registry";

describe("STATIC_FILTER_FIELDS fallback", () => {
  it("covers the membership + aggregate tiers", () => {
    expect(STATIC_FILTER_FIELDS.map((f) => f.field).sort()).toEqual(
      ["cost", "duration_ms", "environment", "errors", "model_name", "total_tokens"].sort(),
    );
  });

  it("categorical fields take `in`, numeric fields take `between`", () => {
    for (const f of STATIC_FILTER_FIELDS) {
      expect(f.operators).toEqual([f.type === "categorical" ? "in" : "between"]);
    }
  });

  it("distinct-query categorical fields carry no static values", () => {
    const model = STATIC_FILTER_FIELDS.find((f) => f.field === "model_name")!;
    expect(model.value_source).toBe("distinct_query");
    expect(model.enum_values).toEqual([]);
  });
});
