// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useRuns: vi.fn(),
  searchParam: vi.fn((_key: string): string | null => null),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", detectorId: "det-1" }),
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => ({ get: (key: string) => mocks.searchParam(key) }),
}));

// Controlled list state so the test asserts the exact range carried back to the list.
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: { id: "7d" }, customStartDate: null, customEndDate: null, keyword: "" },
    queryOptions: { page: 1, limit: 50 },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useDetector: () => ({ data: { name: "My Detector" } }),
}));

// Both tabs are the same table: the page calls useRuns twice — once with
// `identified: true` (Findings) and once without (Runs). The default mock
// returns a triggered run for the identified call and a clean run for the
// plain call so each tab has rows to render. Tests can override useRuns.
const triggeredRun = {
  run_id: "run-1",
  detector_id: "det-1",
  project_id: "proj-1",
  trace_id: "trace-abc",
  finding_id: "f1",
  status: "completed",
  timestamp: "2026-05-01T12:00:00Z",
  summary: "Something went wrong",
  rca_status: "done" as const,
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
      data: query.identified ? [triggeredRun, secondRun] : [cleanRun],
      meta: { total: query.identified ? 2 : 1 },
    },
    isLoading: false,
    error: null,
  };
}

// Only the fetch hook is replaced; the id helpers (selfTraceId, agentTraceId)
// and describeRcaStatus are pure and run for real, so the page is tested
// against the same id derivation the table and deep links use.
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
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
// The panel mock surfaces traceId + autoOpenRca and exposes close/navigate so
// tests can drive the page's panel-mount lifecycle.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: ({
    traceId,
    autoOpenRca,
    source,
    runTimestamp,
    onClose,
    onNavigate,
    canNavigateUp,
    canNavigateDown,
    onOpenLinkedTrace,
  }: {
    traceId: string;
    autoOpenRca?: boolean;
    source?: "detector" | "agent" | "user";
    runTimestamp?: string;
    onClose: () => void;
    onNavigate: (d: "up" | "down") => void;
    canNavigateUp: boolean;
    canNavigateDown: boolean;
    onOpenLinkedTrace?: (t: { traceId: string; source: "detector" | "agent" | "user" }) => void;
  }) => (
    <div
      data-testid="trace-panel"
      data-auto-open-rca={String(autoOpenRca)}
      data-source={String(source)}
      data-run-timestamp={String(runTimestamp)}
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
      <button
        type="button"
        onClick={() => onOpenLinkedTrace?.({ traceId: "f".repeat(32), source: "user" })}
      >
        panel-linked
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
});

describe("DetectorDetailPage", () => {
  it("carries the selected time range back to the list via the Detectors link", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Detectors" }));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors?date_filter=7d");
  });

  it("queries useRuns with identified:true for Findings and without it for Runs", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    const calls = mocks.useRuns.mock.calls.map((c) => c[2] as { identified?: boolean });
    expect(calls.some((q) => q?.identified === true)).toBe(true);
    expect(calls.some((q) => q == null || q.identified === undefined)).toBe(true);
  });

  it("renders the shared table on the Findings tab with the Agent analysis column", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    // The finding id is shown in its own column (correlates a finding to its
    // trace/runs across surfaces).
    expect(screen.getByRole("columnheader", { name: "Finding ID" })).toBeTruthy();
    expect(screen.getByText("f1")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Agent analysis" })).toBeTruthy();
  });

  it("renders the same shared table on the Runs tab, showing N/A for a clean run", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.getByText("trace-clean")).toBeTruthy();
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Agent analysis" })).toBeTruthy();
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

    // Open the first findings row; up is disabled at the top, down is enabled.
    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    expect(screen.getByRole("button", { name: "panel-up" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "panel-down" })).toHaveProperty("disabled", false);

    // Move down to the second row, then back up.
    fireEvent.click(screen.getByRole("button", { name: "panel-down" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-def");
    expect(screen.getByRole("button", { name: "panel-down" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "panel-up" }));
    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-abc");
  });

  it("clears the open panel when its trace leaves the list (e.g. pagination)", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    const { rerender } = render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "trace-abc" }));
    expect(screen.getByTestId("trace-panel")).toBeTruthy();

    // The findings list refetches and no longer contains trace-abc.
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

  it("auto-opens the panel for a ?traceId= deep link", () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    mocks.searchParam.mockImplementation((key: string) => (key === "traceId" ? "trace-def" : null));
    render(<DetectorDetailPage />);

    expect(screen.getByTestId("panel-trace").textContent).toBe("trace-def");
  });

  it("renders the loading state", () => {
    mocks.useRuns.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<DetectorDetailPage />);

    expect(screen.getByText("Loading findings...")).toBeTruthy();
  });

  it("renders the error state", () => {
    mocks.useRuns.mockReturnValue({ data: undefined, isLoading: false, error: new Error("x") });
    render(<DetectorDetailPage />);

    expect(screen.getByText("Error loading findings")).toBeTruthy();
  });

  it("renders the empty state", () => {
    mocks.useRuns.mockReturnValue({
      data: { data: [], meta: { total: 0 } },
      isLoading: false,
      error: null,
    });
    render(<DetectorDetailPage />);

    expect(screen.getByText("No findings found")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));

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

  it("keeps the panel open on a linked-trace hop whose target is not a row of the list", () => {
    // The self-trace's "Analyzed trace" chip re-points the one mounted panel.
    // Its target is a customer trace, opened by the hop rather than from a
    // row — the leave-the-list clearing must not close it.
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    render(<DetectorDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    fireEvent.click(screen.getByRole("button", { name: /aaaa-bbbb/ }));
    expect(screen.getByTestId("trace-panel").getAttribute("data-source")).toBe("detector");

    fireEvent.click(screen.getByRole("button", { name: "panel-linked" }));

    const panel = screen.getByTestId("trace-panel");
    expect(within(panel).getByTestId("panel-trace").textContent).toBe("f".repeat(32));
    expect(panel.getAttribute("data-source")).toBe("user");
    // Not a row: no stepping through the list from here.
    expect(within(panel).getByRole("button", { name: "panel-up" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("auto-opens the self-trace for a ?traceId=&source=detector deep link", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    // What TraceDetectorsTab links for a self-traced run: the dashless run_id
    // plus source=detector, landing on the Runs tab.
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "traceId") return "aaaabbbb";
      if (key === "source") return "detector";
      if (key === "tab") return "runs";
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
      if (key === "tab") return "runs";
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
      if (key === "tab") return "runs";
      return null;
    });
    render(<DetectorDetailPage />);

    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("renders run_id as plain text (no link) when not self_traced", () => {
    mocks.useRuns.mockImplementation(useRunsWithSelfRows);
    render(<DetectorDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.queryByRole("button", { name: /cccc-dddd/ })).toBeNull();
    expect(screen.getByText("cccc-dddd")).toBeTruthy();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

describe("finding_id → RCA agent trace link", () => {
  // Enriched by the runs proxy: attempt 2's trace landed, so the Finding ID
  // cell opens it. The dashless finding id is what the cell displays.
  const analyzedRun = {
    ...triggeredRun,
    run_id: "run-analyzed",
    trace_id: "trace-analyzed",
    finding_id: "3817f98c-1876-6de9-30a2-66452c8e1e9f",
    execution_trace_id: "e".repeat(32),
    execution_trace_status: "available",
  };
  // Its analysis is still exporting: nothing to open yet.
  const pendingRun = {
    ...triggeredRun,
    run_id: "run-pending",
    trace_id: "trace-pending",
    finding_id: "5a1c0000-0000-4000-8000-000000000000",
    execution_trace_id: "a".repeat(32),
    execution_trace_status: "pending",
  };

  function useRunsWithAnalyzedRows(_p: string, _d: string, query: { identified?: boolean } = {}) {
    return {
      data: { data: query.identified ? [analyzedRun, pendingRun] : [], meta: { total: 2 } },
      isLoading: false,
      error: null,
    };
  }

  it("opens the execution's trace with source=agent, quietly, and without the run's timestamp", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /3817f98c18766de930a266452c8e1e9f/ }));

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

  it("renders the finding id as plain text while its analysis trace is not available", () => {
    mocks.useRuns.mockImplementation(useRunsWithAnalyzedRows);
    render(<DetectorDetailPage />);

    const id = "5a1c0000000040008000000000000000";
    expect(screen.queryByRole("button", { name: new RegExp(id) })).toBeNull();
    expect(screen.getByText(id)).toBeTruthy();
  });

  it("auto-opens the analysis trace for a ?traceId=&source=agent deep link", () => {
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

  it("does not auto-open a deep-linked analysis trace whose export has not landed", () => {
    // Same gate as the cell click: the row's execution id matches, but its
    // trace is still pending, so there is nothing to open yet.
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
