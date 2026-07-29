// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  useTraceFindings,
  findingsPollInterval,
  detectorRunsPollInterval,
  rcaPollInterval,
  TRACE_POLL_INTERVAL_MS,
  TRACE_POLL_WINDOW_MS,
  TRACE_POLL_GRACE_MS,
} from "./use-findings";

// Findings and runs arrive a while after ingestion (evaluation is debounced
// ~1min), so a trace opened live has to poll for them — and has to stop. These
// cases pin down each stop condition.

describe("findingsPollInterval — trace-page findings poll cadence", () => {
  it("polls at the interval while no finding exists and the window is open", () => {
    expect(findingsPollInterval(0, 0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops immediately once a finding exists (Alert button + useRca take over)", () => {
    // Even at t=0 with the window wide open, a finding ends polling.
    expect(findingsPollInterval(1, 0)).toBe(false);
    expect(findingsPollInterval(3, 5000)).toBe(false);
  });

  it("stops once the window elapses so an unflagged trace doesn't poll forever", () => {
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS)).toBe(false);
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS + 10_000)).toBe(false);
  });
});

describe("detectorRunsPollInterval — trace-page detector-runs poll cadence", () => {
  it("polls while the window is open so runs appear as they complete", () => {
    expect(detectorRunsPollInterval(0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(detectorRunsPollInterval(TRACE_POLL_WINDOW_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("keeps polling through the debounce, which must not be read as 'nothing coming'", () => {
    expect(detectorRunsPollInterval(65_000)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops once the window elapses", () => {
    expect(detectorRunsPollInterval(TRACE_POLL_WINDOW_MS)).toBe(false);
  });
});

describe("rcaPollInterval — RCA poll cadence through the finding→row gap", () => {
  it("polls while the run is in flight (pending/running), regardless of elapsed time", () => {
    expect(rcaPollInterval("pending", 0)).toBe(TRACE_POLL_INTERVAL_MS);
    // Still polling even past the window — an in-flight run isn't abandoned.
    expect(rcaPollInterval("running", TRACE_POLL_WINDOW_MS + 60_000)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("keeps polling for a missing row through the grace period", () => {
    // The finding is written before the RCA row, so a fresh finding has no row
    // yet (status undefined) and must still be waited on.
    expect(rcaPollInterval(undefined, 0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(rcaPollInterval(undefined, TRACE_POLL_GRACE_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("gives a missing row only the grace period, not the full window", () => {
    // An RCA-disabled detector never writes a row, so waiting minutes for one
    // would poll every such finding for the whole window.
    expect(rcaPollInterval(undefined, TRACE_POLL_GRACE_MS)).toBe(false);
    expect(TRACE_POLL_GRACE_MS).toBeLessThan(TRACE_POLL_WINDOW_MS);
  });

  it("stops on a terminal status", () => {
    expect(rcaPollInterval("done", 0)).toBe(false);
    expect(rcaPollInterval("failed", 0)).toBe(false);
  });
});

/** Renders useTraceFindings with a stubbed backend; `calls` counts the fetches. */
function renderTraceFindings(findingsOnCall: (call: number) => unknown[]) {
  const calls = { findings: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const call = ++calls.findings;
      return { ok: true, json: async () => ({ findings: findingsOnCall(call) }) };
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHook(() => useTraceFindings("p1", "t1"), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
  return calls;
}

describe("useTraceFindings — polling is wired to the interval", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps fetching while findings are empty, then stops once one arrives", async () => {
    vi.useFakeTimers();
    // Empty for the first two polls (the worker hasn't flagged yet), then flagged.
    const calls = renderTraceFindings((call) =>
      call > 2 ? [{ finding_id: "f1", trace_id: "t1" }] : [],
    );

    // Initial fetch.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.findings).toBe(1);

    // Two poll ticks: empty, empty → keeps polling.
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS);
    expect(calls.findings).toBe(3);

    // The third response carried a finding → polling stops; further time is inert.
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS * 4);
    expect(calls.findings).toBe(3);
  });

  it("stops polling once the window has elapsed", async () => {
    vi.useFakeTimers();
    const calls = renderTraceFindings(() => []);

    await vi.advanceTimersByTimeAsync(TRACE_POLL_WINDOW_MS + TRACE_POLL_INTERVAL_MS * 2);
    const atWindow = calls.findings;
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS * 5);
    expect(calls.findings).toBe(atWindow);
  });
});
