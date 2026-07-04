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
}));

import { useUrlFilters } from "./use-url-filters";

beforeEach(() => {
  currentParams = new URLSearchParams();
  replace.mockClear();
});

describe("useUrlFilters", () => {
  it("reads and validates the initial filters from the URL", () => {
    const f: Predicate[] = [{ field: "model_name", op: "in", value: ["a"] }];
    currentParams = new URLSearchParams({ filters: JSON.stringify(f) });
    const { result } = renderHook(() => useUrlFilters());
    expect(result.current.filters).toEqual(f);
  });

  it("ignores a malformed URL value and falls back to an empty list", () => {
    currentParams = new URLSearchParams({ filters: "not json" });
    const { result } = renderHook(() => useUrlFilters());
    expect(result.current.filters).toEqual([]);
  });

  it("setFilters writes the encoded param to the URL and resets the page", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useUrlFilters(onChange));
    const next: Predicate[] = [{ field: "cost", op: "between", value: [0.5, null] }];

    act(() => result.current.setFilters(next));

    expect(result.current.filters).toEqual(next);
    expect(onChange).toHaveBeenCalledTimes(1);
    const url = replace.mock.calls[0][0] as string;
    const raw = new URL(url, "http://x").searchParams.get("filters");
    expect(JSON.parse(raw as string)).toEqual(next);
  });

  it("resets page_index in the same write so a filter applied on page >1 isn't lost", () => {
    currentParams = new URLSearchParams({ page_index: "2" });
    const { result } = renderHook(() => useUrlFilters());
    const next: Predicate[] = [{ field: "cost", op: "between", value: [0.5, null] }];
    act(() => result.current.setFilters(next));
    // A single write carries the new filter AND drops the stale page — no separate
    // page-reset write to clobber the filter from stale params.
    const url = new URL(replace.mock.calls[0][0] as string, "http://x");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual(next);
    expect(url.searchParams.has("page_index")).toBe(false);
  });

  it("setFilters([]) removes the param from the URL", () => {
    currentParams = new URLSearchParams({
      filters: JSON.stringify([{ field: "model_name", op: "in", value: ["a"] }]),
    });
    const { result } = renderHook(() => useUrlFilters());
    act(() => result.current.setFilters([]));
    const url = new URL(replace.mock.calls[0][0] as string, "http://x");
    expect(url.searchParams.has("filters")).toBe(false);
  });

  it("skips the echo of its own write so it isn't re-parsed and clobbered", () => {
    const { result, rerender } = renderHook(() => useUrlFilters());
    const mine: Predicate[] = [{ field: "model_name", op: "in", value: ["a"] }];
    act(() => result.current.setFilters(mine));

    // Echo our OWN write back through searchParams (the real value we just wrote,
    // not an unrelated one). The guard must skip it so `mine` isn't re-parsed away.
    currentParams = new URL(replace.mock.calls[0][0] as string, "http://x").searchParams;
    rerender();

    expect(result.current.filters).toEqual(mine);
  });

  it("re-applying an identical filter set is a no-op that keeps back/forward working", () => {
    const f: Predicate[] = [{ field: "model_name", op: "in", value: ["a"] }];
    currentParams = new URLSearchParams({ filters: JSON.stringify(f) });
    const { result, rerender } = renderHook(() => useUrlFilters());

    // Same predicates → identical URL → no write. The guard must NOT be left armed
    // (an unchanged router.replace would never fire the sync effect to reset it).
    act(() => result.current.setFilters(f));
    expect(replace).not.toHaveBeenCalled();

    // A genuine back/forward must still sync into state — it would be swallowed if
    // the guard were stuck armed from the no-op write above.
    const external: Predicate[] = [{ field: "status", op: "in", value: ["ERROR"] }];
    currentParams = new URLSearchParams({ filters: JSON.stringify(external) });
    rerender();
    expect(result.current.filters).toEqual(external);
  });
});
