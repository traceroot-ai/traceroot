// @vitest-environment jsdom
/**
 * Interaction coverage for the trace viewer shell: header actions (fullscreen,
 * new tab, AI, RCA alert), the offline-eval extension points (header identity /
 * status, diff toggle, selection callbacks) and the tree/timeline scroll sync.
 *
 * Complements TraceViewerPanel.test.tsx, which covers layout and content states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import type { Span, TraceDetail } from "@/types/api";

const mocks = vi.hoisted(() => ({
  aiPanelOpen: false,
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
  setAiInitialSessionId: vi.fn(),
  findings: undefined as unknown,
  rca: undefined as unknown,
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: mocks.aiPanelOpen,
    setAiPanelOpen: mocks.setAiPanelOpen,
    setAiContext: mocks.setAiContext,
    setAiInitialSessionId: mocks.setAiInitialSessionId,
    registerAiHost: () => () => {},
    sidebarCollapsed: false,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: mocks.findings }),
  useRca: () => ({ data: mocks.rca }),
  useTraceDetectorRuns: () => ({ data: undefined, isLoading: false, error: null }),
}));

// The tree and timeline are replaced by probes that surface their callbacks as
// buttons, so selection/collapse/scroll-sync paths are reachable from a test.
const scrollToSpan = vi.hoisted(() => vi.fn());
vi.mock("./SpanTreeView", async () => {
  const React = await import("react");
  return {
    SpanTreeView: React.forwardRef(function TreeProbe(
      props: {
        onSelect: (sel: unknown) => void;
        onToggleCollapse: (id: string) => void;
        collapsedIds: Set<string>;
      },
      ref: React.Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToSpan }));
      return (
        <div>
          <button type="button" onClick={() => props.onSelect({ type: "trace" })}>
            tree-select-trace
          </button>
          <button type="button" onClick={() => props.onToggleCollapse("span-1")}>
            tree-toggle
          </button>
          <span data-testid="collapsed-count">{props.collapsedIds.size}</span>
        </div>
      );
    }),
  };
});
vi.mock("./SpanTimelineView", () => ({
  SpanTimelineView: (props: {
    onSelect: (sel: unknown) => void;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    onScroll: () => void;
  }) => (
    <div data-testid="timeline">
      <div data-testid="timeline-scroll" ref={props.scrollRef} onScroll={props.onScroll} />
      <button
        type="button"
        onClick={() => props.onSelect({ type: "span", span: { span_id: "span-9" } })}
      >
        timeline-select-span
      </button>
    </div>
  ),
}));
vi.mock("./TraceDetectorsTab", () => ({
  TraceDetectorsTab: () => <div data-testid="detectors-tab" />,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
// The detail panel is exercised by SpanInfoPanel.test.tsx; here it only needs to
// report the props the viewer computes for it.
vi.mock("./SpanInfoPanel", () => ({
  SpanInfoPanel: (props: { diffMode?: boolean; spanActions?: React.ReactNode }) => (
    <div data-testid="span-info" data-diff={String(!!props.diffMode)}>
      {props.spanActions}
    </div>
  ),
}));

import { TraceViewerPanel } from "./TraceViewerPanel";

const SPAN: Span = {
  span_id: "span-1",
  trace_id: "trace-1",
  parent_span_id: null,
  name: "root",
  span_kind: "SPAN",
  span_start_time: "2026-07-17T10:24:00.000Z",
  span_end_time: "2026-07-17T10:24:01.000Z",
  status: "OK",
  status_message: null,
  model_name: null,
  cost: null,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  git_source_file: null,
  git_source_line: null,
  git_source_function: null,
};

const TRACE: TraceDetail = {
  trace_id: "trace-1",
  project_id: "proj-1",
  name: "t",
  trace_start_time: "2026-07-17T10:24:00.000Z",
  user_id: null,
  session_id: null,
  git_ref: null,
  git_repo: null,
  environment: "production",
  release: null,
  input: null,
  output: null,
  metadata: null,
  spans: [SPAN],
};

function renderPanel(props: Partial<React.ComponentProps<typeof TraceViewerPanel>> = {}) {
  return render(
    <TraceViewerPanel
      projectId="proj-1"
      traceId="trace-1"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp
      canNavigateDown
      traceOverride={TRACE}
      {...props}
    />,
  );
}

beforeEach(() => {
  mocks.aiPanelOpen = false;
  mocks.findings = undefined;
  mocks.rca = undefined;
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("TraceViewerPanel header actions", () => {
  it("navigates with the up/down buttons", () => {
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });
    fireEvent.click(screen.getByTitle("Previous trace"));
    fireEvent.click(screen.getByTitle("Next trace"));
    expect(onNavigate).toHaveBeenNthCalledWith(1, "up");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "down");
  });

  it("toggles fullscreen from the expand button", () => {
    const { container } = renderPanel();
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("w-[70%]");
    fireEvent.click(screen.getByTitle("Expand to full screen"));
    expect(panel.className).toContain("w-[calc(100%-12rem)]");
    fireEvent.click(screen.getByTitle("Restore default size"));
    expect(panel.className).toContain("w-[70%]");
  });

  it("opens the trace in a new tab with the current filters", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    // No override: under one, traceId is the synthetic eval-<resultId> and this
    // control is deliberately hidden (covered separately below).
    renderPanel({
      traceOverride: undefined,
      dateFilter: { id: "1h" },
      newTabPath: "/projects/proj-1/detectors",
    });
    fireEvent.click(screen.getByTitle("Open in new tab"));
    expect(open).toHaveBeenCalledTimes(1);
    const url = open.mock.calls[0][0] as string;
    expect(url).toContain("/projects/proj-1/detectors");
    expect(url).toContain("traceId=trace-1");
    expect(url).toContain("fullscreen=1");
    vi.unstubAllGlobals();
  });

  it("defaults the new-tab target to the project traces page", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderPanel({ traceOverride: undefined });
    fireEvent.click(screen.getByTitle("Open in new tab"));
    expect(open.mock.calls[0][0]).toContain("/projects/proj-1/traces");
    vi.unstubAllGlobals();
  });

  it("hides the new-tab control and sends no assistant context under an override", () => {
    // Under an override the panel renders a reconstructed eval trace whose id is a
    // synthetic eval-<resultId>: no URL and no assistant lookup can resolve it, so
    // the control is hidden and the assistant gets null rather than a dead id.
    renderPanel();
    expect(screen.queryByTitle("Open in new tab")).toBeNull();
    fireEvent.click(screen.getByTitle("AI Assistant"));
    expect(mocks.setAiContext).toHaveBeenCalledWith(null);
  });

  it("opens a fresh AI chat from the bot button", () => {
    renderPanel({ traceOverride: undefined });
    fireEvent.click(screen.getByTitle("AI Assistant"));
    expect(mocks.setAiContext).toHaveBeenCalledWith({ traceId: "trace-1" });
    expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith(undefined);
    expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true);
  });

  it("closes the panel from the X button", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    // The close button is the only header button without a title.
    const buttons = Array.from(document.querySelectorAll("button"));
    const close = buttons.find((b) => !b.getAttribute("title") && b.className.includes("h-7 w-7"));
    fireEvent.click(close!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("TraceViewerPanel RCA alert", () => {
  it("hides the Alert button when there is no RCA record", () => {
    renderPanel();
    expect(screen.queryByText("Alert")).toBeNull();
  });

  it("opens the RCA session from the Alert button", () => {
    mocks.findings = { findings: [{ finding_id: "f1" }] };
    mocks.rca = { rca: { sessionId: "sess-rca" } };
    renderPanel({ traceOverride: undefined });
    fireEvent.click(screen.getByText("Alert"));
    expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith("sess-rca");
    expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true);
  });

  it("auto-opens the RCA chat when arriving from the findings page", () => {
    mocks.findings = { findings: [{ finding_id: "f1" }] };
    mocks.rca = { rca: { sessionId: "sess-rca" } };
    renderPanel({ traceOverride: undefined, autoOpenRca: true });
    expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith("sess-rca");
    expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true);
  });

  it("does not auto-open while the RCA session is still unresolved", () => {
    mocks.findings = { findings: [{ finding_id: "f1" }] };
    mocks.rca = { rca: null };
    renderPanel({ traceOverride: undefined, autoOpenRca: true });
    expect(mocks.setAiPanelOpen).not.toHaveBeenCalled();
  });
});

describe("TraceViewerPanel offline-eval extensions", () => {
  it("renders the supplied header identity with a copy affordance", () => {
    renderPanel({ headerIdentity: { label: "Test case", value: "case-1" } });
    expect(screen.getByText("Test case")).toBeTruthy();
    expect(screen.getByText("case-1")).toBeTruthy();
    expect(screen.getByTitle("Copy test case id")).toBeTruthy();
  });

  it("renders a header status badge", () => {
    renderPanel({ headerStatus: <span>Passed</span> });
    expect(screen.getByText("Passed")).toBeTruthy();
  });

  it("hides the diff toggle without a baseline", () => {
    renderPanel();
    expect(screen.queryByText("Diff")).toBeNull();
  });

  it("toggles diff mode and forwards it to the detail panel", () => {
    const matchSpan = vi.fn(() => SPAN);
    renderPanel({ diffBaseline: { trace: TRACE, matchSpan } });
    expect(screen.getByTestId("span-info").dataset.diff).toBe("false");
    fireEvent.click(screen.getByText("Diff"));
    expect(screen.getByTestId("span-info").dataset.diff).toBe("true");
    fireEvent.click(screen.getByText("Diff"));
    expect(screen.getByTestId("span-info").dataset.diff).toBe("false");
  });

  it("starts in diff mode when defaultDiffOn is set", () => {
    renderPanel({
      diffBaseline: { trace: TRACE, matchSpan: () => SPAN },
      defaultDiffOn: true,
    });
    expect(screen.getByTestId("span-info").dataset.diff).toBe("true");
  });

  it("renders per-selection span actions", () => {
    renderPanel({
      spanActions: () => <button type="button">Save as test case</button>,
      spanHeaderAction: () => <span>hdr</span>,
      spanExtraTags: () => <span>tag</span>,
    });
    expect(screen.getByText("Save as test case")).toBeTruthy();
  });

  it("notifies the parent when the selection changes", () => {
    const onSelectionChange = vi.fn();
    renderPanel({ onSelectionChange });
    expect(onSelectionChange).toHaveBeenCalledWith({ type: "trace" });
  });
});

describe("TraceViewerPanel tree/timeline behaviour", () => {
  it("records collapse toggles from the tree", () => {
    renderPanel();
    expect(screen.getByTestId("collapsed-count").textContent).toBe("0");
    fireEvent.click(screen.getByText("tree-toggle"));
    expect(screen.getByTestId("collapsed-count").textContent).toBe("1");
    fireEvent.click(screen.getByText("tree-toggle"));
    expect(screen.getByTestId("collapsed-count").textContent).toBe("0");
  });

  it("selects directly from the tree in tree mode", () => {
    const onSelectionChange = vi.fn();
    renderPanel({ onSelectionChange });
    fireEvent.click(screen.getByText("tree-select-trace"));
    expect(onSelectionChange).toHaveBeenCalledWith({ type: "trace" });
  });

  it("returns to the tree and scrolls to the span when the timeline is clicked", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /timeline/i }));
    expect(screen.getByTestId("timeline")).toBeTruthy();
    fireEvent.click(screen.getByText("timeline-select-span"));
    // Back on the tree view, and the deferred scroll lands on the clicked span.
    expect(screen.getByTestId("span-info")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(scrollToSpan).toHaveBeenCalledWith("span-9");
  });

  it("mirrors scrolling between the tree and the timeline", async () => {
    const { container } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /timeline/i }));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const treeScroll = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    const timelineScroll = screen.getByTestId("timeline-scroll") as HTMLDivElement;

    treeScroll.scrollTop = 120;
    fireEvent.scroll(treeScroll);
    expect(timelineScroll.scrollTop).toBe(120);

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    timelineScroll.scrollTop = 260;
    fireEvent.scroll(timelineScroll);
    expect(treeScroll.scrollTop).toBe(260);
  });
});
