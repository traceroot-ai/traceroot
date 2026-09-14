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

  it("sizes the last page by the API's limit cap, not a larger requested page_limit", () => {
    // The list routes cap `limit` at 200, so ?page_limit=500 is served as 200: 1000
    // rows is pages 0-4 and page 3 has rows. Dividing the total by the requested 500
    // would make page 1 the last page and bounce a deep link that is actually valid.
    currentParams = new URLSearchParams({ page_limit: "500", page_index: "3" });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.limit).toBe(200);
    const writesBefore = replace.mock.calls.length;
    act(() => result.current.clampToTotal(1000));
    expect(result.current.page).toBe(3);
    expect(replace.mock.calls.length).toBe(writesBefore);
  });

  it("still clamps a page past the end once the limit is capped", () => {
    // The cap must not disable the clamp: 1000 rows at the served 200 ends at page 4.
    currentParams = new URLSearchParams({ page_limit: "500", page_index: "9" });
    const { result } = renderHook(() => useListPageState());
    act(() => result.current.clampToTotal(1000));
    expect(result.current.page).toBe(4);
  });
});

describe("useUrlPagination limit cap", () => {
  it("caps an over-large page_limit so the request matches what the API serves", () => {
    currentParams = new URLSearchParams({ page_limit: "5000" });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.limit).toBe(200);
    expect(result.current.queryOptions.limit).toBe(200);
  });

  it("caps a programmatic updateLimit and writes the capped value to the URL", () => {
    const { result } = renderHook(() => useListPageState());
    act(() => result.current.updateLimit(1000));
    expect(result.current.limit).toBe(200);
    const url = new URL(replace.mock.calls.at(-1)![0] as string, "http://x");
    expect(url.searchParams.get("page_limit")).toBe("200");
  });

  it("leaves a page_limit at or under the cap untouched", () => {
    currentParams = new URLSearchParams({ page_limit: "100" });
    const { result } = renderHook(() => useListPageState());
    expect(result.current.limit).toBe(100);
  });
});
