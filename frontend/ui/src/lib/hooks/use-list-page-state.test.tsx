// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Predicate } from "@/types/api";

let currentParams = new URLSearchParams();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentParams,
  useRouter: () => ({ replace }),
  usePathname: () => "/traces",
  // The date filter persists its selection per project via useParams.
  useParams: () => ({ projectId: "p1" }),
}));

import { useListPageState } from "./use-list-page-state";

beforeEach(() => {
  currentParams = new URLSearchParams();
  replace.mockClear();
});

describe("useListPageState filters integration", () => {
  it("surfaces URL filters in both queryOptions and combined state", () => {
    const f: Predicate[] = [{ field: "status", op: "in", value: ["ERROR"] }];
    currentParams = new URLSearchParams({ filters: JSON.stringify(f) });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.queryOptions.filters).toEqual(f);
    expect(result.current.state.filters).toEqual(f);
  });

  it("updateFilters writes the encoded param to the URL", () => {
    const { result } = renderHook(() => useListPageState());
    const next: Predicate[] = [{ field: "cost", op: "gte", value: 0.5 }];
    act(() => result.current.updateFilters(next));
    const url = new URL(replace.mock.calls.at(-1)![0] as string, "http://x");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual(next);
  });

  it("passes defaultFilters through to the URL filters hook", () => {
    const defaultFilters: Predicate[] = [{ field: "status", op: "in", value: ["ERROR"] }];
    const { result } = renderHook(() => useListPageState({ defaultFilters }));

    // Absent key -> the configured default surfaces in both queryOptions and state.
    expect(result.current.filters).toEqual(defaultFilters);
    expect(result.current.queryOptions.filters).toEqual(defaultFilters);

    // Clearing it writes the explicit marker rather than deleting the key.
    act(() => result.current.updateFilters([]));
    const url = new URL(replace.mock.calls.at(-1)![0] as string, "http://x");
    expect(url.searchParams.get("filters")).toBe("[]");
  });
});

describe("useListPageState search integration", () => {
  it("restores the search and page from the URL without resetting either", () => {
    currentParams = new URLSearchParams({ search: "foo", page_index: "1" });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.keyword).toBe("foo");
    expect(result.current.queryOptions.search_query).toBe("foo");
    expect(result.current.page).toBe(1);
  });

  it("a debounced search writes the param and returns to the first page in one write", () => {
    vi.useFakeTimers();
    try {
      currentParams = new URLSearchParams({ page_index: "2" });
      const { result } = renderHook(() => useListPageState());
      act(() => result.current.updateKeyword("foo"));
      act(() => vi.advanceTimersByTime(300));

      expect(result.current.page).toBe(0);
      expect(result.current.queryOptions.search_query).toBe("foo");
      expect(replace).toHaveBeenCalledTimes(1);
      const url = new URL(replace.mock.calls[0][0] as string, "http://x");
      expect(url.searchParams.get("search")).toBe("foo");
      expect(url.searchParams.has("page_index")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useListPageState clampToTotal", () => {
  it("pulls a page that is past the end back to the last page with rows", () => {
    // Deleting rows (or a deep link) can leave page_index beyond a shrunken list:
    // 60 rows at the default limit of 50 is pages 0-1, so page 5 has nothing to show.
    currentParams = new URLSearchParams({ page_index: "5" });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.page).toBe(5);
    act(() => result.current.clampToTotal(60));
    expect(result.current.page).toBe(1);
    const url = new URL(replace.mock.calls.at(-1)![0] as string, "http://x");
    expect(url.searchParams.get("page_index")).toBe("1");
  });

  it("leaves a page that is still inside the result set alone", () => {
    currentParams = new URLSearchParams({ page_index: "1" });
    const { result } = renderHook(() => useListPageState());
    const writesBefore = replace.mock.calls.length;
    act(() => result.current.clampToTotal(300));
    expect(result.current.page).toBe(1);
    expect(replace.mock.calls.length).toBe(writesBefore);
  });

  it("ignores a total of 0, which is also what a loading or errored query reports", () => {
    currentParams = new URLSearchParams({ page_index: "3" });
    const { result } = renderHook(() => useListPageState());
    act(() => result.current.clampToTotal(0));
    expect(result.current.page).toBe(3);
  });
});
