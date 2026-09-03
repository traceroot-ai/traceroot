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

  /** A browser whose URL pins a filter, over a project with its own stored pick. */
  const stubUrlAndStorage = (search: string, storedId: string | null) =>
    vi.stubGlobal("window", {
      location: { search },
      localStorage: {
        getItem: (key: string) =>
          key === dateFilterStorageKey("p1") && storedId ? JSON.stringify({ id: storedId }) : null,
      },
    });

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

  it("clamps a stored range that the plan's retention no longer allows", () => {
    // A downgrade leaves the old 90d selection in storage. Neither the label
    // nor the query it names may outrun the window the plan still covers.
    stubStorage(() => JSON.stringify({ id: "90d" }));
    expect(resolveSiteRange("p1", 30)).toEqual(RANGE_PRESETS.find((o) => o.id === "30d"));
  });

  it("keeps the stored range when retention allows it or is still unknown", () => {
    stubStorage(() => JSON.stringify({ id: "90d" }));
    const ninety = RANGE_PRESETS.find((o) => o.id === "90d");
    expect(resolveSiteRange("p1", 90)).toEqual(ninety);
    // Undefined means "retention hasn't resolved yet" — clamping then would
    // narrow every window on a hard reload.
    expect(resolveSiteRange("p1", undefined)).toEqual(ninety);
    expect(resolveSiteRange("p1", null)).toEqual(ninety);
  });

  it("clamps the default fallback too, not just a stored pick", () => {
    stubStorage(() => null);
    expect(resolveSiteRange("p1", 0.25)).toEqual(RANGE_PRESETS.find((o) => o.id === "6h"));
  });

  it("lets the URL's pinned filter win over the project's stored pick", () => {
    // A shared link naming 7d must not leave the cards charting the 1d the
    // picker last stored: the page and everything on it name one window.
    stubUrlAndStorage("?date_filter=7d", "1d");
    expect(resolveSiteRange("p1")).toEqual(RANGE_PRESETS.find((o) => o.id === "7d"));
  });

  it("falls back to the stored pick when the URL pins nothing", () => {
    stubUrlAndStorage("?tab=widgets", "7d");
    expect(resolveSiteRange("p1")).toEqual(RANGE_PRESETS.find((o) => o.id === "7d"));
  });

  it("clamps a URL-pinned range past the plan's retention, like any other", () => {
    stubUrlAndStorage("?date_filter=90d", null);
    expect(resolveSiteRange("p1", 7).durationMinutes).toBeLessThanOrEqual(7 * 24 * 60);
  });

  it("falls back for a URL-pinned id these preset-only surfaces can't draw", () => {
    stubUrlAndStorage("?date_filter=custom&start=x&end=y", null);
    expect(resolveSiteRange("p1")).toEqual(DEFAULT_DATE_FILTER);
  });

  it("survives a window with no location at all", () => {
    // The storage-only stub the tests above use is exactly this shape.
    stubStorage(() => null);
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
