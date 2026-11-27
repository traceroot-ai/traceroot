// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUrlSort } from "./use-url-sort";

const nav = vi.hoisted(() => ({ query: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/projects/p1/traces",
}));

const KEYS = ["timestamp", "latency"] as const;
const NEWEST_FIRST = { key: "timestamp", order: "desc" } as const;

afterEach(() => {
  cleanup();
  nav.query = "";
  nav.replace.mockReset();
});

function written(): URLSearchParams {
  return new URLSearchParams(String(nav.replace.mock.calls.at(-1)?.[0]).split("?")[1]);
}

describe("useUrlSort", () => {
  it("is unsorted without URL params", () => {
    const { result } = renderHook(() => useUrlSort(KEYS));
    expect(result.current.sort).toBeUndefined();
  });

  it("restores a sort from the URL", () => {
    nav.query = "sort=latency&order=asc";
    const { result } = renderHook(() => useUrlSort(KEYS));
    expect(result.current.sort).toEqual({ key: "latency", order: "asc" });
  });

  it("ignores a column the list cannot sort by", () => {
    nav.query = "sort=cost&order=asc";
    const { result } = renderHook(() => useUrlSort(KEYS));
    expect(result.current.sort).toBeUndefined();
  });

  it("sorts a new column descending, back on the first page, keeping other params", () => {
    nav.query = "search=abc&page_index=3";
    const onChange = vi.fn();
    const { result } = renderHook(() => useUrlSort(KEYS, onChange));

    act(() => result.current.toggleSort("latency"));

    expect(Object.fromEntries(written())).toEqual({
      search: "abc",
      sort: "latency",
      order: "desc",
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("reverses the direction of the sorted column", () => {
    nav.query = "sort=latency&order=desc";
    const { result } = renderHook(() => useUrlSort(KEYS));

    act(() => result.current.toggleSort("latency"));

    expect(written().get("order")).toBe("asc");
  });

  it("reverses the default order on the first click of its column", () => {
    const { result } = renderHook(() => useUrlSort(KEYS, undefined, NEWEST_FIRST));

    act(() => result.current.toggleSort("timestamp"));

    expect(written().get("order")).toBe("asc");
  });
});
