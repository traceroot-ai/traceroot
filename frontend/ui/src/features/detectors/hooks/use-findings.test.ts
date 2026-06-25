// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { describeRcaStatus, useRuns, useTraceDetectorRuns } from "./use-findings";

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

describe("describeRcaStatus — the Agent analysis column vocabulary", () => {
  it("renders an em dash when the field is absent (enrichment unavailable)", () => {
    const p = describeRcaStatus(undefined);
    expect(p.label).toBe("—");
    expect(p.title).toBeUndefined();
  });

  it("renders Skipped with an explanatory tooltip when no RCA row exists", () => {
    const p = describeRcaStatus(null);
    expect(p.label).toBe("Skipped");
    expect(p.title).toMatch(/off for the detector/i);
    expect(p.className).toContain("text-muted-foreground");
  });

  it("renders Done for a completed analysis", () => {
    expect(describeRcaStatus("done")).toEqual({
      label: "Done",
      className: "text-foreground",
    });
  });

  it("renders Failed in destructive styling", () => {
    const p = describeRcaStatus("failed");
    expect(p.label).toBe("Failed");
    expect(p.className).toContain("text-destructive");
  });

  it("renders Running… for both pending and running (in-flight states)", () => {
    expect(describeRcaStatus("pending").label).toBe("Running…");
    expect(describeRcaStatus("running").label).toBe("Running…");
  });

  it("falls back to the raw value for an unrecognized future status", () => {
    // Guards against a new worker status (e.g. "canceled") silently rendering
    // as Running… forever.
    const p = describeRcaStatus("canceled" as never);
    expect(p.label).toBe("canceled");
    expect(p.title).toBeUndefined();
  });
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
