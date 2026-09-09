// @vitest-environment jsdom
/**
 * The comparison page has no server route of its own — `useEvaluationRunDetails`
 * fetches each selected run through the by-id run route. That is what puts the
 * comparison behind that route's retention gate (see
 * app/api/.../evaluations/runs/[runId]/route.retention.test.ts), so it is pinned
 * here: a dedicated compare endpoint added later must carry the gate itself.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useEvaluationRunDetails } from "./hooks";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("useEvaluationRunDetails", () => {
  it("reads every compared run through the by-id run route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ run: {}, results: [] }),
    });

    const { result } = renderHook(() => useEvaluationRunDetails("p1", ["run-a", "run-b"]), {
      wrapper,
    });
    await waitFor(() => expect(result.current.every((q) => q.isSuccess)).toBe(true));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/p1/evaluations/runs/run-a",
      "/api/projects/p1/evaluations/runs/run-b",
    ]);
  });

  it("surfaces that route's refusal as an error for that run, never an empty column", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("run-old")
          ? {
              ok: false,
              status: 403,
              json: async () => ({ error: "Data outside retention window" }),
            }
          : { ok: true, status: 200, json: async () => ({ run: {}, results: [] }) },
      ),
    );

    const { result } = renderHook(() => useEvaluationRunDetails("p1", ["run-new", "run-old"]), {
      wrapper,
    });
    await waitFor(() => expect(result.current[1].isError).toBe(true));

    expect(result.current[0].isSuccess).toBe(true);
    expect(result.current[1].data).toBeUndefined();
    expect((result.current[1].error as Error).message).toContain("403");
  });
});
