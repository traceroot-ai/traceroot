// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useKeywordSearch } from "./use-keyword-search";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mountHook(onSearchChange: () => void, strict: boolean) {
  const api: { setKeyword?: (v: string) => void } = {};
  function Probe() {
    api.setKeyword = useKeywordSearch(onSearchChange).setKeyword;
    return null;
  }
  render(
    strict ? (
      <React.StrictMode>
        <Probe />
      </React.StrictMode>
    ) : (
      <Probe />
    ),
  );
  return api;
}

describe("useKeywordSearch", () => {
  it.each([false, true])("does not report a change on mount (StrictMode: %s)", (strict) => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    mountHook(onSearchChange, strict);
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("reports each settled change once, after the debounce", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const api = mountHook(onSearchChange, false);
    act(() => api.setKeyword!("foo"));
    act(() => vi.advanceTimersByTime(299));
    expect(onSearchChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    act(() => api.setKeyword!(""));
    act(() => vi.advanceTimersByTime(300));
    expect(onSearchChange).toHaveBeenCalledTimes(2);
  });
});
