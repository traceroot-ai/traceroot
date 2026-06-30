// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  runs: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  push: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceDetectorRuns: () => ({
    data: mocks.runs === undefined ? undefined : { runs: mocks.runs },
    isLoading: mocks.isLoading,
    error: mocks.error,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, prefetch: mocks.prefetch }),
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    buildUrlWithFilters: (path: string, opts?: { extraParams?: Record<string, string> }) =>
      `URL(${path}${opts?.extraParams?.tab ? `?tab=${opts.extraParams.tab}` : ""})`,
  };
});

import { TraceDetectorsTab, sortDetectorRuns } from "./TraceDetectorsTab";
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
  mocks.push.mockReset();
  mocks.prefetch.mockReset();
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

  it("navigates to the detector's runs tab when a row is clicked", () => {
    mocks.runs = [run({ run_id: "1", detector_id: "det-9", name: "Safety", finding_id: null })];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);

    fireEvent.click(screen.getByText("Safety"));
    expect(mocks.push).toHaveBeenCalledWith("URL(/projects/proj-1/detectors/det-9?tab=runs)");
  });

  it("prefetches the detector route on row hover so navigation feels instant", () => {
    mocks.runs = [run({ run_id: "1", detector_id: "det-9", name: "Safety", finding_id: null })];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);

    const row = screen.getByText("Safety").closest("tr") as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(mocks.prefetch).toHaveBeenCalledWith("URL(/projects/proj-1/detectors/det-9?tab=runs)");
  });

  it("shows an empty state when no detectors ran", () => {
    mocks.runs = [];
    render(<TraceDetectorsTab projectId="proj-1" traceId="trace-1" />);
    expect(screen.getByText(/no detectors ran/i)).toBeTruthy();
  });
});
