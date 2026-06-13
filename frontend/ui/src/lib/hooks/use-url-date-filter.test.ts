// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mutable navigation mock: tests reassign `nav.search` and rerender to simulate
// the URL changing (e.g. navigating to the bare list while the hook stays mounted).
const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  replace: () => {},
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.search,
  useRouter: () => ({ replace: nav.replace, push: () => {} }),
  usePathname: () => "/projects/p1/detectors",
}));

import { useUrlDateFilter } from "./use-url-date-filter";
import { persistDateFilter, readPersistedDateFilter } from "@/lib/date-filter-persistence";
import { findDateFilterOption } from "@/lib/date-filter";

const KEY = "detectors:p1";

beforeEach(() => {
  localStorage.clear();
  nav.search = new URLSearchParams();
});

describe("useUrlDateFilter persistence", () => {
  it("restores a persisted preset on a clean URL", async () => {
    persistDateFilter(KEY, findDateFilterOption("1h"), null, null);
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    await waitFor(() => expect(result.current.dateFilter.id).toBe("1h"));
  });

  it("resets to the page default when nothing is stored", async () => {
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    await waitFor(() => expect(result.current.dateFilter.id).toBe("14d"));
  });

  it("lets an explicit date_filter in the URL win over the stored value", async () => {
    persistDateFilter(KEY, findDateFilterOption("1h"), null, null);
    nav.search = new URLSearchParams("date_filter=3h");
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    await waitFor(() => expect(result.current.dateFilter.id).toBe("3h"));
    // Must not be overridden by the stored 1h.
    expect(result.current.dateFilter.id).toBe("3h");
  });

  // Regression for the latch-ordering bug: arriving via an explicit ?date_filter
  // link must not consume the one-time restore, so a later clean URL still
  // restores the saved preference.
  it("restores the saved preference after the URL becomes clean", async () => {
    persistDateFilter(KEY, findDateFilterOption("1h"), null, null);
    nav.search = new URLSearchParams("date_filter=3h");
    const { result, rerender } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    await waitFor(() => expect(result.current.dateFilter.id).toBe("3h"));

    nav.search = new URLSearchParams(); // navigate to the bare list
    rerender();
    await waitFor(() => expect(result.current.dateFilter.id).toBe("1h"));
  });

  it("persists the selection when a preset is chosen", async () => {
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    await waitFor(() => expect(result.current.dateFilter.id).toBe("14d"));
    act(() => {
      result.current.setDateFilter(findDateFilterOption("6h"));
    });
    expect(result.current.dateFilter.id).toBe("6h");
    expect(readPersistedDateFilter(KEY)?.option.id).toBe("6h");
  });

  it("persists a custom range", async () => {
    const start = new Date("2026-06-13T00:00:00.000Z");
    const end = new Date("2026-06-14T00:00:00.000Z");
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d", KEY));
    act(() => {
      result.current.setCustomRange(start, end);
    });
    const stored = readPersistedDateFilter(KEY);
    expect(stored?.option.isCustom).toBe(true);
    expect(stored?.customStart?.toISOString()).toBe(start.toISOString());
    expect(stored?.customEnd?.toISOString()).toBe(end.toISOString());
  });

  it("does not touch storage when no persistKey is given", async () => {
    const { result } = renderHook(() => useUrlDateFilter(undefined, "14d"));
    act(() => {
      result.current.setDateFilter(findDateFilterOption("6h"));
    });
    expect(localStorage.length).toBe(0);
  });
});
