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

  it.each([0, TRACE_FEED_LIMIT_MAX + 1, 1.5, "10"])("rejects limit=%j", (limit) => {
    const r = parseTraceFeedSpec({ limit });
    expect(r).toEqual({
      ok: false,
      error: `limit must be an integer between 1 and ${TRACE_FEED_LIMIT_MAX}`,
    });
  });
});
