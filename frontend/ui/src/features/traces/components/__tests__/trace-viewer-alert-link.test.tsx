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
    // A minimal loaded trace, so the panel reaches the tree view and mounts
    // SpanInfoPanel — the chip that swaps to the agent trace lives there now.
    return {
      data: { trace_id: "t1", name: "root", trace_start_time: "2026-09-01T00:00:00Z", spans: [] },
      isLoading: false,
      error: null,
    };
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
vi.mock("../SpanInfoPanel", () => ({
  // Surface the analysis-trace wiring (both legs) as real buttons so the test
  // can click the same entry points the chips expose, without rendering the
  // full panel.
  SpanInfoPanel: (props: {
    onViewAnalysisTrace?: () => void;
    analyzedTrace?: { traceId: string; onClick: () => void };
  }) => (
    <div data-testid="span-info">
      {props.onViewAnalysisTrace && (
        <button type="button" onClick={props.onViewAnalysisTrace}>
          Root cause analysis
        </button>
      )}
      {props.analyzedTrace && (
        <button type="button" onClick={props.analyzedTrace.onClick}>
          Analyzed trace: {props.analyzedTrace.traceId.slice(0, 8)}
        </button>
      )}
    </div>
  ),
}));
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
  it("shows the Root cause analysis chip when the RCA trace is available, and swaps the viewer to source=agent", async () => {
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
    const link = await screen.findByRole("button", { name: /root cause analysis/i });
    fireEvent.click(link);

    // The effective query now targets the RCA's agent trace.
    expect(mocks.lastQuery!.queryKey).toContain("agent");
    await mocks.lastQuery!.queryFn();
    expect(mocks.getTrace).toHaveBeenLastCalledWith("p1", "f1f1", "", undefined, "agent");

    expect(await screen.findByRole("button", { name: /analyzed trace:/i })).toBeTruthy();

    // The header now reflects the agent trace being viewed — same as a panel
    // mounted directly with source="agent" (Task 18), not just the fetch target.
    expect(await screen.findByText("Agent")).toBeTruthy();
  });

  it("hides the Detectors tab while viewing the agent trace — detectors never target internal traces", async () => {
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
    // Present on the customer trace…
    expect(await screen.findByRole("button", { name: /detectors/i })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /root cause analysis/i }));

    // …gone on the agent trace, and back once the user returns.
    expect(screen.queryByRole("button", { name: /detectors/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /analyzed trace:/i }));
    expect(await screen.findByRole("button", { name: /detectors/i })).toBeTruthy();
  });

  it("falls back to the tree view when the Detectors tab disappears while active", async () => {
    // The chip that swaps to the agent trace lives in the tree view, so the
    // tab can only vanish under an active Detectors view through a prop
    // change: the detectors page keeps one panel mounted and re-points it
    // from an original trace to a Finding cell's agent trace.
    const props = {
      projectId: "p1",
      onClose: () => {},
      onNavigate: () => {},
      canNavigateUp: false,
      canNavigateDown: false,
    };
    const { rerender } = render(<TraceViewerPanel {...props} traceId="t1" source="user" />);
    fireEvent.click(await screen.findByRole("button", { name: /detectors/i }));
    expect(screen.getByTestId("detectors-tab")).toBeTruthy();
    expect(screen.queryByTestId("span-info")).toBeNull();

    rerender(<TraceViewerPanel {...props} traceId="f1f1" source="agent" />);

    expect(screen.queryByRole("button", { name: /detectors/i })).toBeNull();
    expect(screen.queryByTestId("detectors-tab")).toBeNull();
    expect(await screen.findByTestId("span-info")).toBeTruthy();
  });

  it("pops the agent trace out under its own id and scope, so the new tab does not 404", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <TraceViewerPanel
        projectId="p1"
        traceId="t1"
        onClose={() => {}}
        onNavigate={() => {}}
        canNavigateUp={false}
        canNavigateDown={false}
        source="user"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /root cause analysis/i }));
    fireEvent.click(screen.getByTitle("Open in new tab"));

    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0][0] as string, "http://localhost");
    expect(url.pathname).toBe("/projects/p1/traces");
    expect(url.searchParams.get("traceId")).toBe("f1f1");
    expect(url.searchParams.get("source")).toBe("agent");
    open.mockRestore();
  });
});
