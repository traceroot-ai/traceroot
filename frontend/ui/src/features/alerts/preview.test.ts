import { describe, expect, it } from "vitest";
import { buildPreviewSpec, nextAggregationForMeasure, parseThreshold } from "./preview";
import {
  ALERT_AGGREGATIONS,
  ALERT_MEASURES_BY_VIEW,
  getMeasure,
  getValidAggregations,
  isEvaluableAlertMetric,
} from "./rule-model";

describe("buildPreviewSpec", () => {
  it("maps an engine-backed measure to its spans-view field", () => {
    expect(buildPreviewSpec("SPANS", "latency", "p95")).toEqual({
      view: "spans",
      filters: [],
      metric: { measure: "duration_ms", agg: "p95" },
      breakdown: null,
      display: { type: "line" },
    });
    // The renamed measures are where a mapping mistake hides.
    expect(buildPreviewSpec("SPANS", "total_tokens_per_second", "p95")?.metric).toEqual({
      measure: "tokens_per_second",
      agg: "p95",
    });
  });

  it("routes the unique-id measures through the traces view, where their columns live", () => {
    // A distinct count is the same number at either grain, so these two use traces.
    expect(buildPreviewSpec("SPANS", "unique_user_ids", "uniq")).toEqual({
      view: "traces",
      filters: [],
      metric: { measure: "user_id", agg: "uniq" },
      breakdown: null,
      display: { type: "line" },
    });
    // The string type rule still applies on the traces path.
    expect(buildPreviewSpec("SPANS", "unique_user_ids", "p95")).toBeNull();
  });

  it("returns null for count on a column measure", () => {
    // The engine reserves `count` for its count(*) sentinel, so it stays unavailable.
    expect(buildPreviewSpec("SPANS", "cost", "count")).toBeNull();
    expect(buildPreviewSpec("SPANS", "trace_id", "p95")).toBeNull();
  });

  it("carries complete filters through in order and drops a half-filled row", () => {
    // The engine rejects an empty value, and a row with no value is not a filter either.
    const spec = buildPreviewSpec("SPANS", "cost", "sum", [
      { field: "status", op: "=", value: "ERROR" },
      { field: "status", op: "=", value: "" },
      { field: "", op: "", value: "" },
      { field: "model_name", op: "contains", value: "gpt" },
    ]);

    expect(spec?.filters).toEqual([
      { field: "status", op: "=", value: "ERROR" },
      { field: "model_name", op: "contains", value: "gpt" },
    ]);
  });

  it("refuses to preview a filtered measure that reads from the traces view", () => {
    // span_kind/status/is_root do not exist on traces, so there is no spec that means this.
    for (const measureId of ["unique_user_ids", "unique_session_ids"]) {
      expect(buildPreviewSpec("SPANS", measureId, "uniq")).not.toBeNull();
      expect(
        buildPreviewSpec("SPANS", measureId, "uniq", [
          { field: "span_kind", op: "=", value: "LLM" },
        ]),
      ).toBeNull();
      expect(
        buildPreviewSpec("SPANS", measureId, "uniq", [{ field: "span_kind", op: "=", value: "" }]),
      ).not.toBeNull();
    }
  });

  it("carries a metadata key through and sends none for a field that takes none", () => {
    const keyed = buildPreviewSpec("SPANS", "cost", "sum", [
      { field: "metadata", op: "=", value: "acme", key: "tenant_id" },
    ]);
    const unkeyed = buildPreviewSpec("SPANS", "cost", "sum", [
      { field: "model_name", op: "=", value: "gpt-4o", key: "" },
    ]);

    expect(keyed?.filters).toEqual([
      { field: "metadata", op: "=", value: "acme", key: "tenant_id" },
    ]);
    expect(unkeyed?.filters[0].key).toBeUndefined();
  });

  it("drops a keyless metadata row rather than previewing a filter the alert cannot run", () => {
    const spec = buildPreviewSpec("SPANS", "cost", "sum", [
      { field: "metadata", op: "=", value: "acme" },
    ]);

    expect(spec?.filters).toEqual([]);
  });
});

describe("the form, the preview and the write gate agree", () => {
  const spansMeasures = ALERT_MEASURES_BY_VIEW.SPANS;

  it("previews every combination the aggregation dropdown offers", () => {
    // The bug this pins: the dropdown offered Latency + count and the preview had nothing.
    const unpreviewable: string[] = [];

    for (const measure of spansMeasures) {
      for (const aggregation of getValidAggregations(measure, "SPANS")) {
        if (buildPreviewSpec("SPANS", measure.id, aggregation) === null) {
          unpreviewable.push(`${measure.id} + ${aggregation}`);
        }
      }
    }

    expect(unpreviewable).toEqual([]);
  });

  it("has a spec for exactly the combinations the write gate calls evaluable", () => {
    const disagreements: string[] = [];

    for (const filters of [[], [{ field: "model_name", op: "=", value: "gpt-4o" }]]) {
      for (const measure of spansMeasures) {
        for (const aggregation of ALERT_AGGREGATIONS) {
          const hasSpec = buildPreviewSpec("SPANS", measure.id, aggregation, filters) !== null;
          const isEvaluable = isEvaluableAlertMetric("SPANS", measure.id, aggregation, filters);
          if (hasSpec !== isEvaluable) {
            disagreements.push(
              `${measure.id} + ${aggregation} (${filters.length} filters): preview=${hasSpec} evaluable=${isEvaluable}`,
            );
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
  });
});

describe("isEvaluableAlertMetric", () => {
  it("turns a trace-grain measure unevaluable as soon as it carries a filter", () => {
    for (const measureId of ["unique_user_ids", "unique_session_ids"]) {
      expect(isEvaluableAlertMetric("SPANS", measureId, "uniq", [])).toBe(true);
      expect(
        isEvaluableAlertMetric("SPANS", measureId, "uniq", [
          { field: "model_name", op: "=", value: "gpt-4o" },
        ]),
      ).toBe(false);
    }
  });

  it("ignores a filter row that is not a predicate yet", () => {
    // A half-filled row must not make an otherwise runnable rule unsaveable.
    expect(
      isEvaluableAlertMetric("SPANS", "unique_user_ids", "uniq", [
        { field: "model_name", op: "=", value: "" },
        { field: "metadata", op: "=", value: "acme" },
      ]),
    ).toBe(true);
  });
});

describe("nextAggregationForMeasure", () => {
  it("keeps an aggregation the new measure can still run", () => {
    expect(nextAggregationForMeasure("SPANS", getMeasure("SPANS", "cost")!, "p95")).toBe("p95");
  });

  it("lands a numeric measure on avg rather than inheriting Count's unpreviewable count", () => {
    expect(nextAggregationForMeasure("SPANS", getMeasure("SPANS", "latency")!, "count")).toBe(
      "avg",
    );
  });

  it("lands on an aggregation the dropdown offers, from any measure and any starting point", () => {
    // A measure change outside the offered set would show an aggregation the dropdown lacks.
    const strays: string[] = [];

    for (const measure of ALERT_MEASURES_BY_VIEW.SPANS) {
      const offered = getValidAggregations(measure, "SPANS");
      for (const current of ALERT_AGGREGATIONS) {
        const next = nextAggregationForMeasure("SPANS", measure, current);
        if (!offered.includes(next)) {
          strays.push(`${measure.id} from ${current} landed on ${String(next)}`);
        }
      }
    }

    expect(strays).toEqual([]);
  });
});

describe("parseThreshold", () => {
  it("parses a numeric threshold and returns null for anything else", () => {
    expect(parseThreshold("5")).toBe(5);
    expect(parseThreshold("0.25")).toBe(0.25);
    expect(parseThreshold("")).toBeNull();
    expect(parseThreshold("   ")).toBeNull();
    expect(parseThreshold("abc")).toBeNull();
  });
});
