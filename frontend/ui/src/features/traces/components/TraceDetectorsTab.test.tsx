// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  runs: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  signalHits: [] as unknown[],
  signalDetectors: [] as unknown[],
  signalsPending: false,
  traceSignalsArgs: [] as unknown[],
}));

vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceDetectorRuns: () => ({
    data: mocks.runs === undefined ? undefined : { runs: mocks.runs },
    isLoading: mocks.isLoading,
    error: mocks.error,
  }),
  selfTraceId: (run: { run_id: string }) => run.run_id.replaceAll("-", ""),
}));

vi.mock("@/ee/features/signals/hooks", () => ({
  useTraceSignals: (...args: unknown[]) => {
    mocks.traceSignalsArgs = args;
    return mocks.signalsPending
      ? { data: undefined, isPending: true }
      : { data: { hits: mocks.signalHits, detectors: mocks.signalDetectors }, isPending: false };
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    buildUrlWithFilters: (path: string, opts?: { extraParams?: Record<string, string> }) => {
      const qs = new URLSearchParams(opts?.extraParams ?? {}).toString();
      return `URL(${path}${qs ? `?${qs}` : ""})`;
    },
  };
});

import { TraceDetectorsTab, runSignal, sortDetectorRuns } from "./TraceDetectorsTab";
import type { BackendRun } from "@/features/detectors/hooks/use-findings";

function run(partial: Partial<BackendRun>): BackendRun {
  return {
    run_id: "r",
    detector_id: "d",
    project_id: "p",
    trace_id: "t",
    finding_id: null,
    status: "completed",
    timestamp: "2026-06-01T00:00:00",
    summary: "",
    ...partial,
  };
}

afterEach(() => {
  cleanup();
  mocks.runs = undefined;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.signalHits = [];
  mocks.signalDetectors = [];
  mocks.signalsPending = false;
});

describe("sortDetectorRuns", () => {
  it("orders identified runs first, then alphabetically by name", () => {
    const runs = [
      run({ run_id: "1", name: "Zeta", finding_id: null }),
      run({ run_id: "2", name: "Beta", finding_id: "f-2" }),
      run({ run_id: "3", name: "Alpha", finding_id: null }),
      run({ run_id: "4", name: "Delta", finding_id: "f-4" }),
    ];
    const sorted = sortDetectorRuns(runs).map((r) => r.run_id);
    // triggered (Beta, Delta) sorted alpha first, then non-triggered (Alpha, Zeta)
    expect(sorted).toEqual(["2", "4", "3", "1"]);
  });
});

describe("runSignal", () => {
  const on = { id: "d", enableSignals: true, signalsEnabledAt: "2026-06-01T00:00:00Z" };
  const hit = {
    runId: "r",
    detectorId: "d",
    findingId: "f",
    signalId: "s",
    signalTitle: "S",
    signalStatus: "open" as const,
  };

  it("links a grouped hit, whatever the settings say", () => {
    expect(runSignal(run({ finding_id: "f" }), hit, undefined)).toEqual({ kind: "signal", hit });
  });

  it("is pending for a hit detected after its detector started grouping", () => {
    expect(
      runSignal(run({ finding_id: "f", timestamp: "2026-06-01T00:00:00" }), undefined, on),
    ).toEqual({
      kind: "pending",
    });
  });

  it("is disabled for a hit detected before grouping started, or with grouping off", () => {
    expect(
      runSignal(run({ finding_id: "f", timestamp: "2026-05-31T23:59:59" }), undefined, on),
    ).toEqual({
      kind: "disabled",
    });
    expect(runSignal(run({ finding_id: "f" }), undefined, { ...on, enableSignals: false })).toEqual(
      { kind: "disabled" },
    );
  });

  it("has no signal for a clean run or a detector that no longer exists", () => {
    expect(runSignal(run({ finding_id: null }), undefined, on)).toEqual({ kind: "none" });
    expect(runSignal(run({ finding_id: "f" }), undefined, undefined)).toEqual({ kind: "none" });
  });
});

describe("TraceDetectorsTab", () => {
  it("renders each run's name, identified state, and summary", () => {
    mocks.runs = [
      run({
        run_id: "1",
        name: "Latency detector",
        finding_id: "f-1",
        summary: "Too slow",
      }),
      run({ run_id: "2", name: "Safety detector", finding_id: null }),
    ];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);

    expect(screen.getByText("Latency detector")).toBeTruthy();
    expect(screen.getByText("Safety detector")).toBeTruthy();
    // Summary is shown inline (no expand step); identified renders Yes/No.
    expect(screen.getByText("Too slow")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
    // No outcome badges and no "X of N triggered" header anymore.
    expect(screen.queryByText("Finding")).toBeNull();
    expect(screen.queryByText("Clean")).toBeNull();
    expect(screen.queryByText(/triggered/i)).toBeNull();
  });

  const nameLink = (name: string) => screen.getByRole("link", { name });

  it("links the detector's name to its runs tab", () => {
    mocks.runs = [run({ run_id: "1", detector_id: "det-9", name: "Safety", finding_id: null })];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    expect(nameLink("Safety").getAttribute("href")).toBe(
      "URL(/projects/proj-1/detectors/det-9?tab=runs)",
    );
  });

  it("deep-links a self-traced run straight to its own trace on the detector page", () => {
    mocks.runs = [
      run({
        run_id: "aaaa1111-bbbb-2222-cccc-3333dddd4444",
        detector_id: "det-9",
        name: "Safety",
        finding_id: null,
        self_traced: true,
      }),
    ];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    expect(nameLink("Safety").getAttribute("href")).toBe(
      "URL(/projects/proj-1/detectors/det-9?tab=runs&traceId=aaaa1111bbbb2222cccc3333dddd4444&source=detector)",
    );
  });

  it("keeps the plain runs-tab link for a run without a self-trace", () => {
    mocks.runs = [run({ run_id: "1", detector_id: "det-9", name: "Safety", self_traced: false })];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    expect(nameLink("Safety").getAttribute("href")).toBe(
      "URL(/projects/proj-1/detectors/det-9?tab=runs)",
    );
  });

  it("links a hit to the signal it was grouped into", () => {
    mocks.runs = [
      run({ run_id: "1", detector_id: "det-9", name: "Safety", finding_id: "f-1" }),
      run({ run_id: "2", detector_id: "det-8", name: "Latency", finding_id: null }),
    ];
    mocks.signalHits = [
      {
        runId: "1",
        detectorId: "det-9",
        findingId: "f-1",
        signalId: "sig-1",
        signalTitle: "Unsafe reply",
        signalStatus: "open",
      },
    ];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);

    expect(screen.getByRole("columnheader", { name: "Signal" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Unsafe reply" });
    expect(link.getAttribute("href")).toBe("/projects/proj-1/signals?signalId=sig-1");
    // A run with no grouped hit has no signal.
    const latencyRow = screen.getByText("Latency").closest("tr") as HTMLElement;
    expect(latencyRow.textContent).toContain("—");
  });

  it("says a hit is pending or disabled when it has no signal", () => {
    mocks.runs = [
      run({ run_id: "1", detector_id: "on", name: "Grouping", finding_id: "f-1" }),
      run({ run_id: "2", detector_id: "off", name: "Not grouping", finding_id: "f-1" }),
      run({ run_id: "3", detector_id: "on", name: "Clean", finding_id: null }),
    ];
    mocks.signalDetectors = [
      { id: "on", enableSignals: true, signalsEnabledAt: "2026-05-01T00:00:00Z" },
      { id: "off", enableSignals: false, signalsEnabledAt: "2026-05-01T00:00:00Z" },
    ];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);

    // Asks for the settings of the detectors that ran.
    expect(mocks.traceSignalsArgs).toEqual(["proj-1", "trace-1", ["on", "off", "on"]]);
    const cell = (name: string) =>
      (screen.getByText(name).closest("tr") as HTMLElement).lastElementChild as HTMLElement;
    expect(cell("Grouping").textContent).toBe("Pending");
    expect(cell("Grouping").firstElementChild?.getAttribute("title")).toBe(
      "This identified result is waiting for signal assignment",
    );
    expect(cell("Not grouping").textContent).toBe("Disabled");
    expect(cell("Clean").textContent).toBe("—");
  });

  it("leaves an identified hit's signal blank while the signals load", () => {
    mocks.runs = [run({ run_id: "1", name: "Grouping", finding_id: "f-1" })];
    mocks.signalsPending = true;
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    const row = screen.getByText("Grouping").closest("tr") as HTMLElement;
    expect((row.lastElementChild as HTMLElement).textContent).toBe("");
  });

  it("shows an empty state when no detectors ran", () => {
    mocks.runs = [];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    expect(screen.getByText(/no detectors ran/i)).toBeTruthy();
  });
});
