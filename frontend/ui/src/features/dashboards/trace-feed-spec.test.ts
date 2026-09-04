import { describe, expect, it } from "vitest";
import { MAX_FILTERS } from "@/features/filters/predicate";
import {
  parseTraceFeedSpec,
  TRACE_FEED_DEFAULT_LIMIT,
  TRACE_FEED_LIMIT_MAX,
} from "./trace-feed-spec";

describe("parseTraceFeedSpec", () => {
  it("accepts the seed shape and returns it unchanged", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "errors", op: "gt", value: 0 }], limit: 10 });
    expect(r).toEqual({
      ok: true,
      data: { filters: [{ field: "errors", op: "gt", value: 0 }], limit: 10 },
    });
  });

  it("fills defaults for an empty spec", () => {
    const r = parseTraceFeedSpec({});
    expect(r).toEqual({ ok: true, data: { filters: [], limit: TRACE_FEED_DEFAULT_LIMIT } });
  });

  it("rejects unknown keys (a different dialect must not pass as an empty feed)", () => {
    const r = parseTraceFeedSpec({ view: "traces", filters: [] });
    expect(r).toEqual({ ok: false, error: 'unexpected key "view"' });
  });

  it("coalesces null filters/limit to the defaults, like the renderer", () => {
    const r = parseTraceFeedSpec({ filters: null, limit: null });
    expect(r).toEqual({ ok: true, data: { filters: [], limit: TRACE_FEED_DEFAULT_LIMIT } });
  });

  it("rejects a non-array filters value", () => {
    const r = parseTraceFeedSpec({ filters: { field: "errors", op: "gt", value: 0 } });
    expect(r).toEqual({ ok: false, error: "filters must be an array of trace filter predicates" });
  });

  it("rejects an invalid predicate, naming its index", () => {
    const r = parseTraceFeedSpec({
      filters: [
        { field: "errors", op: "gt", value: 0 },
        { field: "model_name", op: "like", value: "x" },
      ],
    });
    expect(r).toEqual({ ok: false, error: "filters[1] is not a valid trace filter predicate" });
  });

  it("rejects more filters than the trace list accepts", () => {
    const filters = Array.from({ length: MAX_FILTERS + 1 }, () => ({
      field: "errors",
      op: "gt" as const,
      value: 0,
    }));
    const r = parseTraceFeedSpec({ filters });
    expect(r).toEqual({
      ok: false,
      error: `filters must contain at most ${MAX_FILTERS} predicates`,
    });
  });

  it("rejects a predicate naming a field the filter registry does not have", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "not_a_column", op: "eq", value: "x" }] });
    expect(r).toEqual({ ok: false, error: 'filters[0] names unknown field "not_a_column"' });
  });

  it("rejects an operator the field does not accept", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "errors", op: "contains", value: "x" }] });
    expect(r).toEqual({
      ok: false,
      error: 'filters[0] does not accept op "contains" on field "errors"',
    });
  });

  it("rejects a categorical field compared with a numeric operator", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "model_name", op: "gt", value: 1 }] });
    expect(r).toEqual({
      ok: false,
      error: 'filters[0] does not accept op "gt" on field "model_name"',
    });
  });

  it("rejects a non-numeric value on a numeric field", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "cost", op: "eq", value: "1.5" }] });
    expect(r).toEqual({ ok: false, error: 'filters[0] needs a number for field "cost"' });
  });

  it("rejects a fractional value on an integer field", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "total_tokens", op: "gt", value: 1.5 }] });
    expect(r).toEqual({
      ok: false,
      error: 'filters[0] needs a whole number for field "total_tokens"',
    });
  });

  it("rejects a negative value on a numeric field", () => {
    // Every filterable metric is non-negative, so a negative bound matches nothing
    // and would store a widget the query engine rejects on every render.
    const r = parseTraceFeedSpec({ filters: [{ field: "total_tokens", op: "gt", value: -1 }] });
    expect(r).toEqual({
      ok: false,
      error: 'filters[0] needs a non-negative number for field "total_tokens"',
    });
  });

  it("rejects a negative fractional value on a non-integer numeric field", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "cost", op: "lt", value: -0.5 }] });
    expect(r).toEqual({
      ok: false,
      error: 'filters[0] needs a non-negative number for field "cost"',
    });
  });

  it("accepts zero, the boundary of the non-negative rule", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "errors", op: "gt", value: 0 }] });
    expect(r).toEqual({
      ok: true,
      data: { filters: [{ field: "errors", op: "gt", value: 0 }], limit: TRACE_FEED_DEFAULT_LIMIT },
    });
  });

  it("accepts a fractional value on a non-integer numeric field", () => {
    const r = parseTraceFeedSpec({ filters: [{ field: "cost", op: "gt", value: 1.5 }] });
    expect(r).toEqual({
      ok: true,
      data: { filters: [{ field: "cost", op: "gt", value: 1.5 }], limit: TRACE_FEED_DEFAULT_LIMIT },
    });
  });

  it("accepts a keyed metadata predicate the registry allows", () => {
    const filters = [{ field: "metadata", key: "session_id", op: "contains", value: "abc" }];
    const r = parseTraceFeedSpec({ filters });
    expect(r).toEqual({ ok: true, data: { filters, limit: TRACE_FEED_DEFAULT_LIMIT } });
  });

  it("names the offending index when a later predicate is unknown", () => {
    const r = parseTraceFeedSpec({
      filters: [
        { field: "errors", op: "gt", value: 0 },
        { field: "span_kind", op: "eq", value: "LLM" },
      ],
    });
    expect(r).toEqual({ ok: false, error: 'filters[1] names unknown field "span_kind"' });
  });

  it.each([0, TRACE_FEED_LIMIT_MAX + 1, 1.5, "10"])("rejects limit=%j", (limit) => {
    const r = parseTraceFeedSpec({ limit });
    expect(r).toEqual({
      ok: false,
      error: `limit must be an integer between 1 and ${TRACE_FEED_LIMIT_MAX}`,
    });
  });
});
