import { describe, expect, it } from "vitest";
import {
  WidgetSchemaField,
  WidgetSpecSchema,
  filterOpLabel,
  generateWidgetTitle,
  isEnumerableFilter,
  isSpecComplete,
  parseSpec,
} from "./types";

const validSpec = {
  view: "spans",
  filters: [{ field: "span_kind", op: "=", value: "LLM" }],
  metric: { measure: "cost", agg: "sum" },
  breakdown: "model_name",
  display: { type: "line" },
};

describe("WidgetSpecSchema", () => {
  it("accepts a valid spec", () => {
    expect(WidgetSpecSchema.safeParse(validSpec).success).toBe(true);
  });
  it("rejects unknown display type", () => {
    const bad = { ...validSpec, display: { type: "gauge" } };
    expect(WidgetSpecSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects pie and bar without a breakdown — they'd have nothing to chart", () => {
    for (const type of ["pie", "bar"]) {
      const bad = { ...validSpec, breakdown: null, display: { type } };
      expect(WidgetSpecSchema.safeParse(bad).success).toBe(false);
      expect(WidgetSpecSchema.safeParse({ ...bad, breakdown: "model_name" }).success).toBe(true);
    }
  });
  it("keeps line/area/table valid without a breakdown", () => {
    for (const type of ["line", "area", "table"]) {
      const ok = { ...validSpec, breakdown: null, display: { type } };
      expect(WidgetSpecSchema.safeParse(ok).success).toBe(true);
    }
  });
});

describe("isSpecComplete", () => {
  it("false while view or metric missing", () => {
    expect(isSpecComplete({ view: "spans" })).toBe(false);
    expect(isSpecComplete({ ...validSpec, metric: undefined })).toBe(false);
  });
  it("true for a runnable spec", () => {
    expect(isSpecComplete(validSpec)).toBe(true);
  });
});

describe("parseSpec", () => {
  it("applies defaults so filters is [] when omitted", () => {
    const { filters: _omit, ...withoutFilters } = validSpec;
    const result = parseSpec(withoutFilters);
    expect(result).not.toBeNull();
    expect(result!.filters).toEqual([]);
  });
});

describe("isEnumerableFilter", () => {
  const stringField = {
    type: "string" as const,
    label: "Model",
    filterOps: ["=", "!=", "contains"],
    groupable: true,
    aggs: [],
  };
  const numberField = { ...stringField, type: "number" as const, label: "Cost" };

  it("true for string equality ops (dropdown of stored values)", () => {
    expect(isEnumerableFilter(stringField, "=")).toBe(true);
    expect(isEnumerableFilter(stringField, "!=")).toBe(true);
  });
  it("false for contains (free text) and numeric fields", () => {
    expect(isEnumerableFilter(stringField, "contains")).toBe(false);
    expect(isEnumerableFilter(numberField, "=")).toBe(false);
  });
  it("false while no field or op picked", () => {
    expect(isEnumerableFilter(undefined, "=")).toBe(false);
    expect(isEnumerableFilter(stringField, "")).toBe(false);
  });
});

describe("filterOpLabel", () => {
  const stringField = {
    type: "string" as const,
    label: "Model",
    filterOps: ["=", "!=", "contains"],
    groupable: true,
    aggs: [],
  };
  const numberField = { ...stringField, type: "number" as const, label: "Cost" };

  it("words string equality like the trace-list filter builder", () => {
    expect(filterOpLabel(stringField, "=")).toBe("is");
    expect(filterOpLabel(stringField, "!=")).toBe("is not");
    expect(filterOpLabel(stringField, "contains")).toBe("contains");
  });
  it("uses the trace-list comparison symbols for numeric ops", () => {
    expect(filterOpLabel(numberField, ">=")).toBe("≥");
    expect(filterOpLabel(numberField, "<=")).toBe("≤");
    expect(filterOpLabel(numberField, "!=")).toBe("≠");
    expect(filterOpLabel(numberField, "=")).toBe("=");
    expect(filterOpLabel(numberField, ">")).toBe(">");
    expect(filterOpLabel(numberField, "<")).toBe("<");
  });
  it("falls back to the raw op when the field is unknown", () => {
    expect(filterOpLabel(undefined, ">=")).toBe("≥");
    expect(filterOpLabel(undefined, "=")).toBe("=");
  });
});

describe("generateWidgetTitle", () => {
  const fields = {
    cost: { type: "number", label: "Cost", filterOps: [], groupable: false, aggs: ["sum"] },
    duration_ms: {
      type: "number",
      label: "Latency",
      filterOps: [],
      groupable: false,
      aggs: ["p95"],
    },
    model_name: { type: "string", label: "Model", filterOps: [], groupable: true, aggs: [] },
  } as Record<string, WidgetSchemaField>;

  it("names agg + measure with registry labels", () => {
    expect(
      generateWidgetTitle({ view: "traces", metric: { measure: "cost", agg: "sum" } }, fields),
    ).toBe("Total Cost");
    expect(
      generateWidgetTitle(
        { view: "traces", metric: { measure: "duration_ms", agg: "p95" } },
        fields,
      ),
    ).toBe("p95 Latency");
  });

  it("appends the breakdown label", () => {
    expect(
      generateWidgetTitle(
        { view: "spans", metric: { measure: "cost", agg: "sum" }, breakdown: "model_name" },
        fields,
      ),
    ).toBe("Total Cost by Model");
  });

  it("names count widgets after the view", () => {
    expect(
      generateWidgetTitle({ view: "spans", metric: { measure: "count", agg: "count" } }, fields),
    ).toBe("Count of spans");
  });

  it("is empty until measure and agg are chosen", () => {
    expect(generateWidgetTitle({ view: "spans" }, fields)).toBe("");
    expect(generateWidgetTitle({ view: "spans", metric: { measure: "cost" } }, fields)).toBe("");
  });

  it("falls back to raw field names when the schema lacks a label", () => {
    expect(
      generateWidgetTitle({ view: "spans", metric: { measure: "input_tokens", agg: "avg" } }, {}),
    ).toBe("Avg input_tokens");
  });
});
