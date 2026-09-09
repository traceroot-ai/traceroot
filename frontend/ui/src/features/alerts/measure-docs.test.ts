import { describe, expect, it } from "vitest";
import { MEASURE_TYPE_LABEL, getMeasureDoc, undocumentedMeasureIds } from "./measure-docs";
import { ALERT_AGGREGATIONS, ALERT_MEASURES_BY_VIEW } from "./rule-model";

describe("alert measure docs", () => {
  it("documents every measure the dropdown renders", () => {
    expect(undocumentedMeasureIds("SPANS")).toEqual([]);
  });

  it("carries the in-house measure table's units, normalized rather than copied", () => {
    // Units are full words, capitalized and plural; USD stays as is, and Count's INT is a type.
    const units = Object.fromEntries(
      ALERT_MEASURES_BY_VIEW.SPANS.map((m) => [m.id, getMeasureDoc("SPANS", m.id)?.unit]),
    );
    expect(units).toEqual({
      count: "Spans",
      trace_id: "Traces",
      latency: "Milliseconds",
      cost: "USD",
      input_tokens: "Tokens",
      output_tokens: "Tokens",
      total_tokens: "Tokens",
      total_tokens_per_second: "Tokens per second",
      unique_user_ids: "Users",
      unique_session_ids: "Sessions",
    });
  });

  it("keeps the type chip from repeating an aggregation's name", () => {
    // The row renders `Type: <label>` beside the aggregation, so the label must not be one.
    const aggregations = new Set<string>(ALERT_AGGREGATIONS.map((a) => a.toLowerCase()));
    const collisions = Object.entries(MEASURE_TYPE_LABEL).filter(([, label]) =>
      aggregations.has(label.toLowerCase()),
    );
    expect(collisions).toEqual([]);
  });

  it("describes measures at span grain, never quoting the trace-grain rollups", () => {
    // Under M0 a measure is a bare column, so no description may bake in a sum or say request.
    for (const measure of ALERT_MEASURES_BY_VIEW.SPANS) {
      const description = getMeasureDoc("SPANS", measure.id)?.description ?? "";
      expect(description, measure.id).not.toMatch(/\bsum\(/);
      expect(description, measure.id).not.toMatch(/\brequests?\b/i);
    }
    expect(getMeasureDoc("SPANS", "cost")?.description).toBe("Cost recorded on one span.");
  });

  it("marks no measure as unavailable", () => {
    // The unique-id measures compute through traces, so nothing in the dropdown is blocked.
    const blocked = ALERT_MEASURES_BY_VIEW.SPANS.filter(
      (m) => getMeasureDoc("SPANS", m.id)?.unavailable !== undefined,
    ).map((m) => m.id);
    expect(blocked).toEqual([]);
  });

  it("describes the id measures against traces, where their columns live", () => {
    for (const id of ["unique_user_ids", "unique_session_ids"]) {
      const doc = getMeasureDoc("SPANS", id);
      expect(doc?.description, id).toContain("a trace belongs to");
      expect(doc?.unavailable, id).toBeUndefined();
    }
  });
});
