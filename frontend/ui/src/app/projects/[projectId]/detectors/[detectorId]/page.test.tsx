// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useRuns: vi.fn(),
  searchParam: vi.fn((_key: string): string | null => null),
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
  setAiInitialSessionId: vi.fn(),
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

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    setAiPanelOpen: mocks.setAiPanelOpen,
    setAiContext: mocks.setAiContext,
    setAiInitialSessionId: mocks.setAiInitialSessionId,
  }),
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

vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useRuns: (...args: unknown[]) => (mocks.useRuns as (...a: unknown[]) => unknown)(...args),
  describeRcaStatus: (status: unknown) => ({
    label: status === "done" ? "Done" : "—",
    className: "",
  }),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
// The panel mock surfaces traceId + autoOpenRca and exposes close/navigate so
// tests can drive the page's panel-mount lifecycle.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: ({
    traceId,
    autoOpenRca,
    onClose,
    onNavigate,
    canNavigateUp,
    canNavigateDown,
  }: {
    traceId: string;
    autoOpenRca?: boolean;
    onClose: () => void;
    onNavigate: (d: "up" | "down") => void;
    canNavigateUp: boolean;
    canNavigateDown: boolean;
  }) => (
    <div data-testid="trace-panel" data-auto-open-rca={String(autoOpenRca)}>
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

describe("DetectorDetailPage AI panel restoration", () => {
  it("does not open AI panel when ai param is absent", async () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    render(<DetectorDetailPage />);
    await waitFor(() => {});
    expect(mocks.setAiPanelOpen).not.toHaveBeenCalledWith(true);
  });

  it("opens AI panel and sets context when ai=1 and traceId are in the URL", async () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "ai") return "1";
      if (key === "traceId") return "trace-1";
      return null;
    });
    render(<DetectorDetailPage />);
    await waitFor(() => expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true));
    expect(mocks.setAiContext).toHaveBeenCalledWith({ traceId: "trace-1" });
  });

  it("restores the chat session when sessionId is also in the URL", async () => {
    mocks.useRuns.mockImplementation(defaultUseRuns);
    mocks.searchParam.mockImplementation((key: string) => {
      if (key === "ai") return "1";
      if (key === "traceId") return "trace-1";
      if (key === "sessionId") return "sess-42";
      return null;
    });
    render(<DetectorDetailPage />);
    await waitFor(() => expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith("sess-42"));
  });
});
