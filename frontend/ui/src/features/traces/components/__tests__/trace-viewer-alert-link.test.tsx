// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  lastQuery: undefined as { queryKey: unknown[]; queryFn: () => unknown } | undefined,
  getTrace: vi.fn(
    async (
      _projectId: string,
      _traceId: string,
      _cursor?: string,
      _limit?: number,
      _source?: string,
    ) => undefined,
  ),
}));

// The panel calls useQuery directly (no QueryClientProvider in this render) —
// capture the options passed to it so we can assert the effective traceId /
// source threaded through on each render, and invoke queryFn to assert the
// getTrace call it makes.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; queryFn: () => unknown }) => {
    mocks.lastQuery = opts;
    return { data: undefined, isLoading: false, error: null };
  },
}));
vi.mock("@/lib/api", () => ({ getTrace: mocks.getTrace }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: { findings: [{ finding_id: "f1" }] } }),
  useRca: () => ({
    data: { rca: { sessionId: "s1", status: "done", traceId: "f1f1", traceStatus: "available" } },
  }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    registerAiHost: () => () => {},
    sidebarCollapsed: false,
  }),
}));
vi.mock("../SpanTreeView", () => ({ SpanTreeView: () => null }));
vi.mock("../SpanInfoPanel", () => ({ SpanInfoPanel: () => <div data-testid="span-info" /> }));
vi.mock("../SpanTimelineView", () => ({ SpanTimelineView: () => <div data-testid="timeline" /> }));
vi.mock("../TraceDetectorsTab", () => ({
  TraceDetectorsTab: () => <div data-testid="detectors-tab" />,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("@/components/RetentionGateBanner", () => ({
  RetentionGateBanner: () => <div data-testid="retention-banner" />,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { TraceViewerPanel } from "../TraceViewerPanel";

afterEach(() => {
  cleanup();
  mocks.getTrace.mockClear();
});

describe("Alert panel → agent trace", () => {
  it("shows View analysis trace when the RCA trace is available, and swaps the viewer to source=agent", async () => {
    render(
      <TraceViewerPanel
        projectId="p1"
        traceId="t1"
        onClose={() => {}}
        onNavigate={() => {}}
        canNavigateUp={false}
        canNavigateDown={false}
      />,
    );
    const link = await screen.findByRole("button", { name: /view analysis trace/i });
    fireEvent.click(link);

    // The effective query now targets the RCA's agent trace.
    expect(mocks.lastQuery!.queryKey).toContain("agent");
    await mocks.lastQuery!.queryFn();
    expect(mocks.getTrace).toHaveBeenLastCalledWith("p1", "f1f1", "", undefined, "agent");

    expect(await screen.findByRole("button", { name: /back to trace/i })).toBeTruthy();
  });
});
