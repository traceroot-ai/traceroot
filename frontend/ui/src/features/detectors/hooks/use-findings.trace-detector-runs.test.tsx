// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTraceDetectorRuns } from "./use-findings";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ runs: [{ run_id: "run-1", detector_id: "det-a", name: "Latency" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, fetchMock };
}

describe("useTraceDetectorRuns", () => {
  it("fetches the trace-detector-runs proxy and returns parsed runs", async () => {
    const { wrapper, fetchMock } = setup();
    const { result } = renderHook(() => useTraceDetectorRuns("proj-1", "trace-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/proj-1/traces/trace-1/detector-runs");
    expect(result.current.data).toEqual({
      runs: [{ run_id: "run-1", detector_id: "det-a", name: "Latency" }],
    });
  });
});
