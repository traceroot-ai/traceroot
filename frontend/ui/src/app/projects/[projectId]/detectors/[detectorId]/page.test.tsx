// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useRuns: vi.fn(),
  searchParam: vi.fn((_key: string): string | null => null),
  searchEntries: vi.fn((): [string, string][] => []),
  filters: [] as Array<{ field: string; op: "in"; value: string[] }>,
  updateFilters: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", detectorId: "det-1" }),
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => ({
    get: (key: string) => mocks.searchParam(key),
    entries: () => mocks.searchEntries()[Symbol.iterator](),
  }),
}));

// Controlled list state so the test asserts the exact range carried back to the
// list and the URL filters the page reads.
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: { id: "7d" },
      customStartDate: null,
      customEndDate: null,
      keyword: "",
      filters: mocks.filters,
    },
    queryOptions: { page: 1, limit: 50 },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateFilters: mocks.updateFilters,
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useDetector: () => ({ data: { name: "My Detector" } }),
}));

// One runs table: the page calls useRuns with `identified: true` only under the
// Identified = Yes filter. The default mock returns the two triggered runs for
// that call and every run otherwise. Tests can override useRuns.
const triggeredRun = {
  run_id: "run-1",
  detector_id: "det-1",
  project_id: "proj-1",
  trace_id: "trace-abc",
  finding_id: "f1",
  status: "completed",
  timestamp: "2026-05-01T12:00:00Z",
  summary: "Something went wrong",
  signal_id: "sig-1",
  agent_trace_id: null as string | null,
};
const secondRun = {
  ...triggeredRun,
  run_id: "run-1b",
  finding_id: "f2",
  trace_id: "trace-def",
  summary: "Second",
};
const cleanRun = {
  run_id: "run-2",
  detector_id: "det-1",
  project_id: "proj-1",
  trace_id: "trace-clean",
  finding_id: null,
  status: "completed",
  timestamp: "2026-05-01T12:05:00Z",
  summary: "",
};

function defaultUseRuns(_p: string, _d: string, query: { identified?: boolean } = {}) {
  return {
    data: {
      data: query.identified ? [triggeredRun, secondRun] : [triggeredRun, secondRun, cleanRun],
      meta: { total: query.identified ? 2 : 3 },
    },
    isLoading: false,
    error: null,
  };
}

// Only the fetch hook is replaced; the id helper (selfTraceId) is pure and runs
// for real, so the page is tested against the same id derivation the table and
// deep links use.
vi.mock("@/features/detectors/hooks/use-findings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/detectors/hooks/use-findings")>()),
  useRuns: (...args: unknown[]) => (mocks.useRuns as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({
    retentionDays: 15,
    showPricing: false,
    onUpgradeClick: vi.fn(),
    closePricing: vi.fn(),
    workspaceId: "ws-1",
    billingPlan: "free",
  }),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
// The bar itself is out of scope; what the page puts in it (the filter chip) renders.
vi.mock("@/components/search-filter-bar", () => ({
  SearchFilterBar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
// The panel mock surfaces traceId + autoOpenRca and exposes close/navigate so
// tests can drive the page's panel-mount lifecycle.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: ({
    traceId,
    autoOpenRca,
    source,
    runTimestamp,
    newTabParams,
    onClose,
    onNavigate,
    canNavigateUp,
    canNavigateDown,
  }: {
    traceId: string;
    autoOpenRca?: boolean;
    source?: "detector" | "agent" | "user";
    runTimestamp?: string;
    newTabParams?: Record<string, string>;
    onClose: () => void;
    onNavigate: (d: "up" | "down") => void;
    canNavigateUp: boolean;
    canNavigateDown: boolean;
  }) => (
    <div
      data-testid="trace-panel"
      data-auto-open-rca={String(autoOpenRca)}
      data-source={String(source)}
      data-run-timestamp={String(runTimestamp)}
      data-new-tab-params={JSON.stringify(newTabParams ?? null)}
    >
      <span data-testid="panel-trace">{traceId}</span>
      <button type="button" onClick={onClose}>
        panel-close
      </button>
      <button type="button" disabled={!canNavigateUp} onClick={() => onNavigate("up")}>
        panel-up
      </button>
      <button type="button" disabled={!canNavigateDown} onClick={() => onNavigate("down")}>
        panel-down
      </button>
    </div>
  ),
}));

import DetectorDetailPage from "./page";

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
  mocks.useRuns.mockReset();
  mocks.useRuns.mockImplementation(defaultUseRuns);
  mocks.searchParam.mockReset();
  mocks.searchParam.mockReturnValue(null);
  mocks.searchEntries.mockReset();
  mocks.searchEntries.mockReturnValue([]);
  mocks.filters = [];
  mocks.updateFilters.mockClear();
});

describe("DetectorDetailPage", () => {
  it("carries the selected time range back to the list via the Detectors link", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Detectors" }));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors?date_filter=7d");
  });

  it("shows every run in one table by default, with no tabs", () => {
    render(<DetectorDetailPage />);

    const calls = mocks.useRuns.mock.calls.map((c) => c[2] as { identified?: boolean });
    expect(calls.every((q) => !q.identified)).toBe(true);
    expect(screen.getByText("trace-clean")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Findings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Runs" })).toBeNull();
  });

  it("shows only identified runs under the Identified filter, and its chip removes just it", () => {
    const status = { field: "status", op: "in" as const, value: ["failed"] };
    mocks.filters = [{ field: "identified", op: "in", value: ["Yes"] }, status];
    render(<DetectorDetailPage />);

    const calls = mocks.useRuns.mock.calls.map((c) => c[2] as { identified?: boolean });
    expect(calls.every((q) => q.identified === true)).toBe(true);
    expect(screen.queryByText("trace-clean")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter Identified is Yes" }));
    expect(mocks.updateFilters).toHaveBeenCalledWith([status]);
  });

  it("shows Signal ID and Agent Run ID instead of the finding's own id and RCA", () => {
    render(<DetectorDetailPage />);

    for (const header of ["Signal ID", "Agent Run ID"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    for (const gone of ["Finding ID", "Agent analysis"]) {
      expect(screen.queryByRole("columnheader", { name: gone })).toBeNull();
    }
    // The signal opens on the Signals page, in the same time range.
    const href = screen.getAllByRole("link", { name: "sig-1" })[0].getAttribute("href")!;
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/projects/proj-1/signals");
    expect(url.searchParams.get("signalId")).toBe("sig-1");
    expect(url.searchParams.get("date_filter")).toBe("7d");
  });

  it("opens the trace viewer with autoOpenRca when a trace_id cell is clicked", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    expect(screen.queryByTestId("trace-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));

    const panel = screen.getByTestId("trace-panel");
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-abc");
    expect(panel.getAttribute("data-auto-open-rca")).toBe("true");
  });

  it("does not make the whole row a click target", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByText("Something went wrong"));
    expect(screen.queryByTestId("trace-panel")).toBeNull();

    const row = screen.getByText("Something went wrong").closest("tr")!;
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("closes the panel, clearing the selected trace", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    expect(screen.getByTestId("trace-panel")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "panel-close" }));
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("navigates between rows from the panel and bounds the nav buttons", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    // Open the first row; up is disabled at the top, down is enabled.
    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    expect(screen.getByRole("button", { name: "panel-up" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "panel-down" })).toHaveProperty("disabled", false);

    // Move down to the last row, then back up.
    fireEvent.click(screen.getByRole("button", { name: "panel-down" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-def");
    fireEvent.click(screen.getByRole("button", { name: "panel-down" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-clean");
    expect(screen.getByRole("button", { name: "panel-down" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "panel-up" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-def");

    fireEvent.click(screen.getByRole("button", { name: "panel-up" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-abc");
  });

  it("clears the open panel when its trace leaves the list (e.g. pagination)", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    const { rerender } = render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    expect(screen.getByTestId("trace-panel")).toBeTruthy();

    // The list refetches and no longer contains trace-abc.
    mocks.useRuns.mockImplementation(
      (_p: string, _d: string, q: { identified?: boolean } = {}) => ({
        data: { data: q.identified ? [secondRun] : [cleanRun], meta: { total: 1 } },
        isLoading: false,
        error: null,
      }),
    );
    rerender(<DetectorDetailPage />);

    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("hands its list state, not an earlier deep link, to the trace's new tab", () => {
    const filters = JSON.stringify([{ field: "identified", op: "in", value: ["Yes"] }]);
    mocks.searchEntries.mockReturnValue([
      ["filters", filters],
      ["page_index", "2"],
      ["traceId", "old"],
      ["source", "agent"],
      ["fullscreen", "1"],
    ]);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    const params = JSON.parse(
      screen.getByTestId("trace-panel").getAttribute("data-new-tab-params")!,
    ) as Record<string, string>;
    // A popped-out trace lands on the same filtered page, so its row is there.
    expect(params).toEqual({ filters, page_index: "2" });
  });

  it("auto-opens the panel for a ?traceId= deep link", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    mocks.searchParam.mockImplementation((key: string) => (key === "traceId" ? "trace-def" : null));
    render(<DetectorDetailPage />);

    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-def");
  });

  it("renders the loading state", () => {
    mocks.useRuns.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<DetectorDetailPage />);

    expect(screen.getByText("Loading runs...")).toBeTruthy();
  });

  it("renders the error state", () => {
    mocks.useRuns.mockReturnValue({ data: undefined, isLoading: false, error: new Error("x") });
    render(<DetectorDetailPage />);

    expect(screen.getByText("Error loading runs")).toBeTruthy();
  });

  it("renders the empty state", () => {
    mocks.useRuns.mockReturnValue({
      data: { data: [], meta: { total: 0 } },
      isLoading: false,
      error: null,
    });
    render(<DetectorDetailPage />);

    expect(screen.getByText("No runs found")).toBeTruthy();
  });
});

describe("run_id → self-trace link", () => {
  const selfRun = {
    run_id: "aaaa-bbbb",
    detector_id: "det-1",
    project_id: "proj-1",
    trace_id: "trace-self",
    finding_id: null,
    status: "completed",
    timestamp: "2026-05-01T12:10:00Z",
    summary: "",
    self_traced: true,
  };
  const plainRun = { ...selfRun, run_id: "cccc-dddd", trace_id: "trace-plain", self_traced: false };

  function useRunsWithSelfRows(_p: string, _d: string, query: { identified?: boolean } = {}) {
    return {
      data: { data: query.identified ? [] : [selfRun, plainRun], meta: { total: 2 } },
      isLoading: false,
      error: null,
    };
  }

  it("opens the dashless self-trace with source=detector when self_traced", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    render(<DetectorDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /aaaa-bbbb/ }));

    const panel = screen.getByTestId("trace-panel");
    expect(within(panel).getByTestId("panel-trace").textContent).toBe("aaaabbbb");
    expect(panel.getAttribute("data-source")).toBe("detector");
    expect(panel.getAttribute("data-auto-open-rca")).toBe("false");
    // The panel time-bounds its "still being recorded" copy off this, so the row's
    // own timestamp has to reach it — passing the wrong field would silently make
    // every self-trace 404 read as a permanent export failure.
    expect(panel.getAttribute("data-run-timestamp")).toBe(selfRun.timestamp);
    // A self-trace is a point-open — it can never step into an original trace.
    expect(within(panel).getByRole("button", { name: "panel-up" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(panel).getByRole("button", { name: "panel-down" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("auto-opens the self-trace for a ?traceId=&source=detector deep link", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    // What TraceDetectorsTab links for a self-traced run: the dashless run_id
    // plus source=detector.
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return "aaaabbbb";
      if (key === "source") return "detector";
      return null;
    });
    render(<DetectorDetailPage />);

    const panel = screen.getByTestId("trace-panel");
    expect(within(panel).getByTestId("panel-trace").textContent).toBe("aaaabbbb");
    expect(panel.getAttribute("data-source")).toBe("detector");
    expect(panel.getAttribute("data-auto-open-rca")).toBe("false");
  });

  it("honors a second deep link without a remount", () => {
    // Navigating detector -> same detector from a trace's Detectors tab changes only the
    // query string, so the component stays mounted. A one-shot boolean latch swallowed
    // every link after the first, leaving the URL claiming one trace and the panel
    // showing another.
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    let currentTraceId = "aaaabbbb";
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return currentTraceId;
      if (key === "source") return "detector";
      return null;
    });

    const { rerender } = render(<DetectorDetailPage />);
    expect(within(screen.getByTestId("trace-panel")).getByTestId("panel-trace").textContent).toBe(
      "aaaabbbb",
    );

    // Second link, same mount — the other self-traced run in the fixture.
    currentTraceId = "ccccdddd";
    rerender(<DetectorDetailPage />);
    expect(within(screen.getByTestId("trace-panel")).getByTestId("panel-trace").textContent).toBe(
      "ccccdddd",
    );
  });

  it("does not auto-open when the deep-linked self-trace matches no run row", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return "eeeeffff";
      if (key === "source") return "detector";
      return null;
    });
    render(<DetectorDetailPage />);

    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("renders run_id as plain text (no link) when not self_traced", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    render(<DetectorDetailPage />);
    expect(screen.queryByRole("button", { name: /cccc-dddd/ })).toBeNull();
    expect(screen.getByText("cccc-dddd")).toBeTruthy();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

describe("Agent Run ID → the signal's RCA agent trace", () => {
  // Enriched by the runs proxy: the RCA its signal shows has a landed trace.
  const analyzedRun = {
    ...triggeredRun,
    run_id: "run-analyzed",
    trace_id: "trace-analyzed",
    signal_id: "sig-9",
    agent_trace_id: "e".repeat(32),
  };
  // Its signal has no analysis trace yet: nothing to open.
  const pendingRun = {
    ...triggeredRun,
    run_id: "run-pending",
    trace_id: "trace-pending",
    signal_id: "sig-8",
    agent_trace_id: null,
  };

  function useRunsWithAnalyzedRows() {
    return {
      data: { data: [analyzedRun, pendingRun], meta: { total: 2 } },
      isLoading: false,
      error: null,
    };
  }

  it("opens the agent trace with source=agent, quietly, and without the run's timestamp", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "e".repeat(32) }));

    const panel = screen.getByTestId("trace-panel");
    expect(within(panel).getByTestId("panel-trace").textContent).toBe("e".repeat(32));
    expect(panel.getAttribute("data-source")).toBe("agent");
    expect(panel.getAttribute("data-auto-open-rca")).toBe("false");
    // The run's timestamp bounds the self-trace pending window only; passed
    // here it made an available-but-not-ingested analysis trace read as a
    // permanently failed export.
    expect(panel.getAttribute("data-run-timestamp")).toBe("undefined");
    // A point-open, like a self-trace: no stepping into original traces.
    expect(within(panel).getByRole("button", { name: "panel-up" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers no agent run while the signal has no analysis trace", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    render(<DetectorDetailPage />);

    const row = screen.getByText("trace-pending").closest("tr")!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["trace-pending"]);
  });

  it("auto-opens the agent trace for a ?traceId=&source=agent deep link", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    // What the viewer's "open in new tab" builds while showing the analysis.
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return "e".repeat(32);
      if (key === "source") return "agent";
      return null;
    });
    render(<DetectorDetailPage />);

    const panel = screen.getByTestId("trace-panel");
    expect(within(panel).getByTestId("panel-trace").textContent).toBe("e".repeat(32));
    expect(panel.getAttribute("data-source")).toBe("agent");
    expect(panel.getAttribute("data-auto-open-rca")).toBe("false");
  });

  it("does not auto-open a deep-linked agent trace that no run on the page shows", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return "a".repeat(32);
      if (key === "source") return "agent";
      return null;
    });
    render(<DetectorDetailPage />);

    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});
