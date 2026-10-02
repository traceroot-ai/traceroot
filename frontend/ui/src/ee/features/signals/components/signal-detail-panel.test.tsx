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

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: () => null,
}));

vi.mock("@/features/dashboards/components/renderers", () => ({
  QueryWidgetRenderer: () => null,
}));

vi.mock("./run-rca", () => ({ RunRca: () => null }));
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
    rca: { currentState: null, canonicalFindingId: null },
    canonicalRca: null,
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

vi.mock("../hooks", () => ({
  useSignal: () => ({ data: signalDetail, isPending: false, error: null }),
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
  layoutMocks.setAiPanelOpen.mockReset();
  layoutMocks.setAiContext.mockReset();
  layoutMocks.setAiInitialSessionId.mockReset();
  layoutMocks.release.mockReset();
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

    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", ["trace-1"]);
  });
});
