// @vitest-environment jsdom
import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEvaluationRunDetails } from "./hooks";
import { BASELINE_RUN, PAIRED_FIXTURE } from "./compare/__tests__/paired-fixture";

describe("useEvaluationRunDetails", () => {
  it("keeps returning the same value across renders while no query changes", () => {
    // The comparison page derives every pair's comparison from this value, so a fresh
    // array on each render (e.g. each search keystroke) would recompute all of it.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    for (const b of PAIRED_FIXTURE) {
      client.setQueryData(["evaluations", "run", "p1", b.run.id], b);
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const ids = PAIRED_FIXTURE.map((b) => b.run.id);
    const { result, rerender } = renderHook(() => useEvaluationRunDetails("p1", [...ids]), {
      wrapper,
    });
    const first = result.current;
    expect(first.find((q) => q.data?.run.id === BASELINE_RUN.id)?.isLoading).toBe(false);
    rerender();
    expect(result.current).toBe(first);
  });
});
