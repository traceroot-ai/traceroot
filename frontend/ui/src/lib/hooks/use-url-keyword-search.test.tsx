// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let currentParams = new URLSearchParams();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentParams,
  useRouter: () => ({ replace }),
  usePathname: () => "/traces",
}));

import { useUrlKeywordSearch } from "./use-url-keyword-search";

beforeEach(() => {
  vi.useFakeTimers();
  currentParams = new URLSearchParams();
  replace.mockClear();
});
afterEach(() => vi.useRealTimers());

// Let the 300ms debounce elapse and flush the effects it triggers.
const settle = () => act(() => vi.advanceTimersByTime(300));

const lastUrl = () => new URL(replace.mock.calls.at(-1)![0] as string, "http://x");

describe("useUrlKeywordSearch", () => {
  it("starts from the URL keyword without writing the URL or resetting the page", () => {
    currentParams = new URLSearchParams({ search: "foo", page_index: "2" });
    const onChange = vi.fn();
    const { result } = renderHook(() => useUrlKeywordSearch(onChange));

    expect(result.current.keyword).toBe("foo");
    expect(result.current.searchQuery).toBe("foo");
    // The debounce timer firing with the initial value is not a change.
    settle();
    expect(replace).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("writes only the debounced keyword, dropping page_index in the same replace", () => {
    currentParams = new URLSearchParams({ page_index: "2", date_filter: "7d" });
    const onChange = vi.fn();
    const { result } = renderHook(() => useUrlKeywordSearch(onChange));

    act(() => result.current.setKeyword("f"));
    act(() => result.current.setKeyword("fo"));
    act(() => result.current.setKeyword("foo"));
    // The input is immediate; the query and URL wait for the debounce.
    expect(result.current.keyword).toBe("foo");
    expect(result.current.searchQuery).toBeUndefined();
    expect(replace).not.toHaveBeenCalled();

    settle();
    expect(result.current.searchQuery).toBe("foo");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/traces?date_filter=7d&search=foo", { scroll: false });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clearing the keyword removes the param", () => {
    currentParams = new URLSearchParams({ search: "foo" });
    const { result } = renderHook(() => useUrlKeywordSearch());

    act(() => result.current.setKeyword(""));
    settle();
    expect(replace).toHaveBeenCalledWith("/traces", { scroll: false });
    expect(result.current.searchQuery).toBeUndefined();
  });

  it("adopts an external URL change (back/forward) without writing or resetting", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(() => useUrlKeywordSearch(onChange));

    currentParams = new URLSearchParams({ search: "bar", page_index: "3" });
    rerender();
    expect(result.current.keyword).toBe("bar");
    expect(result.current.searchQuery).toBe("bar");

    settle();
    expect(replace).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips the echo of its own write and keeps typing through unrelated URL changes", () => {
    const { result, rerender } = renderHook(() => useUrlKeywordSearch());
    act(() => result.current.setKeyword("foo"));
    settle();

    // Echo our own write back through searchParams.
    currentParams = lastUrl().searchParams;
    rerender();
    expect(result.current.keyword).toBe("foo");

    // Mid-typing, another hook changes the page: the in-flight input must survive.
    act(() => result.current.setKeyword("foob"));
    currentParams = new URLSearchParams({ search: "foo", page_index: "1" });
    rerender();
    expect(result.current.keyword).toBe("foob");
  });

  it("does not write when the debounced keyword settles back to the URL value", () => {
    currentParams = new URLSearchParams({ search: "foo" });
    const onChange = vi.fn();
    const { result } = renderHook(() => useUrlKeywordSearch(onChange));

    act(() => result.current.setKeyword("foox"));
    act(() => result.current.setKeyword("foo"));
    settle();
    expect(replace).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
