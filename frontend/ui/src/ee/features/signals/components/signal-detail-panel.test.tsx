// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const layoutMocks = vi.hoisted(() => ({
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
  setAiInitialSessionId: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: layoutMocks.setAiPanelOpen,
    setAiContext: layoutMocks.setAiContext,
    setAiInitialSessionId: layoutMocks.setAiInitialSessionId,
    registerAiHost: () => layoutMocks.release,
  }),
}));

vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

vi.mock("@/features/dashboards/components/renderers", () => ({
  QueryWidgetRenderer: () => null,
}));

vi.mock("./run-rca", () => ({
  RunRca: ({ state }: { state: string | null }) => <div>run-rca:{String(state)}</div>,
}));
vi.mock("./signal-status-control", () => ({ SignalStatusControl: () => null }));

const signalDetail = vi.hoisted(() => ({
  merged: false,
  signal: {
    id: "sig-1",
    detectorId: "det-1",
    detectorName: "Det",
    title: "Tool times out",
    status: "open",
    hitCount: 1,
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    createTime: "2026-01-01T00:00:00Z",
    criteriaCovers: "Covers X",
    criteriaExcludes: "Excludes Y",
    criteriaValidated: true as boolean | null,
    reopenSeq: 0,
    rca: { currentState: null as string | null, canonicalFindingId: null },
    canonicalRca: null as {
      findingId: string;
      reopenSeq: number;
      traceId: string | null;
      sessionId: string | null;
      result: string | null;
    } | null,
    rcaHistory: [] as {
      reopenSeq: number;
      findingId: string;
      status: string;
      createTime: string;
    }[],
  },
  grouping: false,
  hits: [
    {
      runId: "run-1",
      traceId: "trace-1",
      findingId: "finding-1",
      seenAt: "2026-01-01T00:00:00Z",
      traceStartTime: "2026-01-01T00:00:00Z",
    },
  ],
  window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", granularity: "day" },
  hitSeries: [],
  statusEvents: [],
}));

/** Set per test: true while the previous window's answer stands in for a new one. */
const signalQuery = vi.hoisted(() => ({ isPlaceholderData: false }));

vi.mock("../hooks", () => ({
  useSignal: () => ({
    data: signalDetail,
    isPending: false,
    error: null,
    isPlaceholderData: signalQuery.isPlaceholderData,
  }),
  useSignalTraces: () => ({ data: new Map(), isPending: false }),
}));

import { SignalDetailPanel } from "./signal-detail-panel";

function renderPanel(onOpenTrace = vi.fn()) {
  render(
    <SignalDetailPanel
      projectId="proj-1"
      signalId="sig-1"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp={false}
      canNavigateDown={false}
      onOpenTrace={onOpenTrace}
      range={{}}
      rangePicker={null}
      tracesHref="/projects/proj-1/traces"
      fullscreen={false}
      onToggleFullscreen={vi.fn()}
    />,
  );
  return onOpenTrace;
}

afterEach(() => {
  cleanup();
  signalQuery.isPlaceholderData = false;
  signalDetail.signal.criteriaValidated = true;
  signalDetail.signal.reopenSeq = 0;
  signalDetail.signal.rca = { currentState: null, canonicalFindingId: null };
  signalDetail.signal.canonicalRca = null;
  signalDetail.signal.rcaHistory = [];
  layoutMocks.setAiPanelOpen.mockReset();
  layoutMocks.setAiContext.mockReset();
  layoutMocks.setAiInitialSessionId.mockReset();
  layoutMocks.release.mockReset();
});

describe("SignalDetailPanel analysis of an earlier opening", () => {
  const analysed = (reopenSeq: number) => {
    signalDetail.signal.canonicalRca = {
      findingId: "f0",
      reopenSeq,
      traceId: null,
      sessionId: null,
      result: "Root cause: the tool times out",
    };
    signalDetail.signal.rcaHistory = [
      { reopenSeq: 0, findingId: "f0", status: "done", createTime: "2026-01-01T00:00:00Z" },
    ];
  };

  it("says the analysis is from before the signal reopened, and offers a new one", () => {
    analysed(0);
    signalDetail.signal.reopenSeq = 1;
    renderPanel();
    expect(screen.getByText(/from an earlier occurrence/)).toBeTruthy();
    // No analysis was asked for the reopening: the cooldown or a Manual detector.
    expect(screen.getByText(/No new analysis started automatically/)).toBeTruthy();
    expect(screen.getByText("run-rca:null")).toBeTruthy();
    expect(screen.getByText("Root cause: the tool times out")).toBeTruthy();
  });

  it("passes the reopening's failed state on, without the cooldown line", () => {
    analysed(0);
    signalDetail.signal.reopenSeq = 1;
    signalDetail.signal.rca = { currentState: "failed", canonicalFindingId: null };
    renderPanel();
    expect(screen.getByText(/from an earlier occurrence/)).toBeTruthy();
    expect(screen.queryByText(/No new analysis started automatically/)).toBeNull();
    expect(screen.getByText("run-rca:failed")).toBeTruthy();
  });

  it("says nothing extra when the analysis is of the current opening", () => {
    analysed(1);
    signalDetail.signal.reopenSeq = 1;
    renderPanel();
    expect(screen.queryByText(/from an earlier occurrence/)).toBeNull();
    expect(screen.queryByText(/^run-rca:/)).toBeNull();
    expect(screen.getByText("Root cause: the tool times out")).toBeTruthy();
  });
});

describe("SignalDetailPanel criteria check", () => {
  it("says when the criteria did not pass their check at creation", () => {
    signalDetail.signal.criteriaValidated = false;
    renderPanel();
    expect(screen.getByText(/did not pass the check when the signal was created/)).toBeTruthy();
  });

  it("says nothing when they passed, or when no check ran", () => {
    for (const value of [true, null]) {
      signalDetail.signal.criteriaValidated = value;
      renderPanel();
      expect(screen.queryByText(/did not pass the check/)).toBeNull();
      cleanup();
    }
  });
});

describe("SignalDetailPanel AI host cleanup", () => {
  it("clears the AI panel state when the host unmounts, not just the slot", () => {
    const { unmount } = render(
      <SignalDetailPanel
        projectId="proj-1"
        signalId="sig-1"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        canNavigateUp={false}
        canNavigateDown={false}
        onOpenTrace={vi.fn()}
        range={{}}
        rangePicker={null}
        tracesHref="/projects/proj-1/traces"
        fullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(layoutMocks.setAiPanelOpen).not.toHaveBeenCalled();

    unmount();

    expect(layoutMocks.release).toHaveBeenCalledTimes(1);
    expect(layoutMocks.setAiPanelOpen).toHaveBeenCalledWith(false);
    expect(layoutMocks.setAiContext).toHaveBeenCalledWith(null);
    expect(layoutMocks.setAiInitialSessionId).toHaveBeenCalledWith(undefined);
  });
});

describe("SignalDetailPanel affected traces", () => {
  it("opens a trace on Enter, not just on click", () => {
    const onOpenTrace = renderPanel();
    const row = screen.getByText("trace-1").closest("tr")!;

    fireEvent.keyDown(row, { key: "Enter" });

    expect(onOpenTrace).toHaveBeenCalledWith("trace-1");
  });
});

describe("SignalDetailPanel time window refresh", () => {
  it("marks the affected traces busy too while a new window loads", () => {
    signalQuery.isPlaceholderData = true;
    renderPanel();

    // The rows still belong to the previous window, so they fade with the chart.
    expect(screen.getByText("trace-1").closest('[aria-busy="true"]')).not.toBeNull();
    const headline = screen.getByText(
      (_, el) => el?.tagName === "P" && /affected$/.test(el.textContent ?? ""),
    );
    expect(headline.closest('[aria-busy="true"]')).not.toBeNull();
  });

  it("does not mark anything busy once the window has loaded", () => {
    renderPanel();

    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
