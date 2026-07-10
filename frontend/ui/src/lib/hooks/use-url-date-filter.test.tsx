// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATE_FILTER_OPTIONS, findDateFilterOption } from "@/lib/date-filter";
import { dateFilterStorageKey, readStoredDateFilter } from "@/lib/date-filter-storage";
import { useUrlDateFilter } from "./use-url-date-filter";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace }),
  usePathname: () => "/projects/p1/traces",
  useParams: () => ({ projectId: "p1" }),
}));

const KEY = dateFilterStorageKey("p1");

beforeEach(() => {
  search = "";
  localStorage.clear();
});
afterEach(() => {
  replace.mockReset();
});

describe("useUrlDateFilter persistence", () => {
  it("adopts the stored per-project preset when the URL has no filter", async () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "7d" }));

    const { result } = renderHook(() => useUrlDateFilter());

    await waitFor(() => expect(result.current.dateFilter.id).toBe("7d"));
  });

  it("lets an explicit URL filter win over the stored preference", async () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "7d" }));
    search = "date_filter=30m";

    const { result, rerender } = renderHook(() => useUrlDateFilter());

    expect(result.current.dateFilter.id).toBe("30m");
    // Flush effects, then pin that adopting the link never wrote the store.
    rerender();
    await waitFor(() => expect(result.current.dateFilter.id).toBe("30m"));
    expect(readStoredDateFilter("p1")?.id).toBe("7d");
  });

  it("resets pagination when restoring changes the effective window", async () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "7d" }));
    const onFilterChange = vi.fn();

    const { result } = renderHook(() => useUrlDateFilter(onFilterChange));

    await waitFor(() => expect(result.current.dateFilter.id).toBe("7d"));
    expect(onFilterChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire the change callback when the stored value matches the default", () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "1d" }));
    const onFilterChange = vi.fn();

    renderHook(() => useUrlDateFilter(onFilterChange));

    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("ignores a stored custom range with inverted bounds", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        id: "custom",
        start: "2026-07-02T00:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
      }),
    );

    const { result } = renderHook(() => useUrlDateFilter());

    await waitFor(() => expect(result.current.dateFilter.id).toBe("1d"));
    expect(result.current.customStartDate).toBeNull();
  });

  it("persists a picked preset so other pages can adopt it", () => {
    const { result } = renderHook(() => useUrlDateFilter());

    act(() => result.current.setDateFilter(findDateFilterOption("30d")));

    expect(readStoredDateFilter("p1")).toEqual({ id: "30d" });
    expect(result.current.dateFilter.id).toBe("30d");
  });

  it("persists a custom range with its bounds", () => {
    const { result } = renderHook(() => useUrlDateFilter());
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-02T00:00:00Z");

    act(() => result.current.setCustomRange(start, end));

    expect(readStoredDateFilter("p1")).toEqual({
      id: "custom",
      start: start.toISOString(),
      end: end.toISOString(),
    });
  });

  it("restores a stored custom range, bounds included", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        id: "custom",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-02T00:00:00.000Z",
      }),
    );

    const { result } = renderHook(() => useUrlDateFilter());

    await waitFor(() => expect(result.current.dateFilter.isCustom).toBe(true));
    expect(result.current.customStartDate?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(result.current.customEndDate?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("ignores a stored custom entry with unparseable bounds", async () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "custom", start: "garbage" }));

    const { result } = renderHook(() => useUrlDateFilter());

    // Nothing to adopt: stays at the shared default instead of a broken custom.
    await waitFor(() =>
      expect(result.current.dateFilter.id).toBe(DATE_FILTER_OPTIONS.find((o) => o.id === "1d")!.id),
    );
    expect(result.current.customStartDate).toBeNull();
  });
});
