import { afterEach, describe, expect, it, vi } from "vitest";
// range-presets is now a thin adapter over the shared date-filter module (one
// source of truth for presets/default across trace list, dashboard, and the
// builder preview) — these tests pin that contract rather than a local list.
import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import { dateFilterStorageKey } from "@/lib/date-filter-storage";
import { DEFAULT_RANGE_ID, RANGE_PRESETS, makeRange, resolveSiteRange } from "./range-presets";

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

describe("resolveSiteRange", () => {
  // These tests run in vitest's node environment, where no `window` exists —
  // exactly the SSR case resolveSiteRange must survive. A stubbed window with
  // a controllable localStorage stands in for the browser.
  const stubStorage = (getItem: (key: string) => string | null) =>
    vi.stubGlobal("window", { localStorage: { getItem } });

  afterEach(() => vi.unstubAllGlobals());

  it("reads the site's own storage slot and returns the stored preset", () => {
    const getItem = vi.fn((key: string) =>
      key === dateFilterStorageKey("p1") ? JSON.stringify({ id: "7d" }) : null,
    );
    stubStorage(getItem);
    expect(resolveSiteRange("p1")).toEqual(RANGE_PRESETS.find((o) => o.id === "7d"));
    // The exact key the trace list and dashboard pages persist through —
    // never a second slot of this module's own.
    expect(getItem).toHaveBeenCalledWith(dateFilterStorageKey("p1"));
  });

  it("falls back to the default when nothing is stored", () => {
    stubStorage(() => null);
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
  });

  it("falls back silently for an unknown stored id", () => {
    stubStorage(() => JSON.stringify({ id: "eleventy" }));
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
  });

  it("falls back for a stored custom range these preset-only surfaces can't draw", () => {
    stubStorage(() =>
      JSON.stringify({ id: "custom", start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }),
    );
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
  });

  it("falls back when storage throws (privacy modes)", () => {
    stubStorage(() => {
      throw new Error("denied");
    });
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
  });

  it("falls back with no window at all (SSR) and with no project to key by", () => {
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
    expect(resolveSiteRange(undefined)).toEqual(DEFAULT_DATE_FILTER);
    expect(resolveSiteRange(null)).toEqual(DEFAULT_DATE_FILTER);
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
