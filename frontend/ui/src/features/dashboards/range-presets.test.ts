import { describe, expect, it } from "vitest";
// range-presets is now a thin adapter over the shared date-filter module (one
// source of truth for presets/default across trace list, dashboard, and the
// builder preview) — these tests pin that contract rather than a local list.
import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import { DEFAULT_RANGE_ID, RANGE_PRESETS, makeRange } from "./range-presets";

describe("makeRange", () => {
  it("spans exactly the preset's duration, ending now", () => {
    const before = Date.now();
    const r = makeRange("7d");
    const after = Date.now();
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 86_400_000);
    expect(r.end.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.end.getTime()).toBeLessThanOrEqual(after);
  });

  it("falls back to the shared default window for unknown ids", () => {
    const r = makeRange("nope");
    expect(r.end.getTime() - r.start.getTime()).toBe(DEFAULT_DATE_FILTER.durationMinutes! * 60_000);
  });
});

describe("RANGE_PRESETS", () => {
  it("is exactly the shared date-filter options minus custom", () => {
    expect(RANGE_PRESETS).toEqual(DATE_FILTER_OPTIONS.filter((o) => o.durationMinutes !== null));
  });

  it("defaults to the same option as the trace list and dashboard", () => {
    expect(DEFAULT_RANGE_ID).toBe(DEFAULT_DATE_FILTER.id);
  });
});
