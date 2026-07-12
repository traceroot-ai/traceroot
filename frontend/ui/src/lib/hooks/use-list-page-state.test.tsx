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
