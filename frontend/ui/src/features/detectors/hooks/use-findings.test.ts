// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { selfTraceId, useRuns, useTraceDetectorRuns } from "./use-findings";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRuns — runs fetch", () => {
  it("appends identified=true to the runs URL when filtering to triggered runs", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    });

    const { result } = renderHook(() => useRuns("proj-1", "det-1", { identified: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/projects/proj-1/detectors/det-1/runs");
    expect(url).toContain("identified=true");
  });

  it("omits identified from the URL for the unfiltered runs view", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    });

    const { result } = renderHook(() => useRuns("proj-1", "det-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("identified");
  });

  it("throws when the runs request fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useRuns("proj-1", "det-1"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("500");
  });
});

describe("useTraceDetectorRuns — per-trace runs fetch", () => {
  // The success path lives in use-findings.trace-detector-runs.test.tsx; cover
  // only the error branch here so the throw isn't left untested.
  it("throws when the trace detector-runs request fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    const { result } = renderHook(() => useTraceDetectorRuns("proj-1", "trace-1"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("404");
  });
});

describe("selfTraceId", () => {
  // The read side of the run-to-trace correlation: the emitter forces the self-trace's
  // trace_id to the dashless run id, and this is the only place the UI reconstructs it.
  // A drift here breaks every self-trace link, so pin the transform against the emit side.
  it("strips dashes from a uuid run id", () => {
    expect(selfTraceId({ run_id: "aaaa1111-bbbb-2222-cccc-3333dddd4444" })).toBe(
      "aaaa1111bbbb2222cccc3333dddd4444",
    );
  });

  it("leaves an already-dashless id untouched", () => {
    // The shape deterministicRunId actually produces on the worker side.
    expect(selfTraceId({ run_id: "a".repeat(32) })).toBe("a".repeat(32));
  });

  it("produces a valid trace id shape", () => {
    expect(selfTraceId({ run_id: "aaaa1111-bbbb-2222-cccc-3333dddd4444" })).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });
});
