// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sidebarCollapsed: false,
  trace: {} as unknown,
  traceError: null as unknown,
  traceLoading: false,
  aiPanelOpen: false,
  detection: undefined as unknown,
  finding: undefined as unknown,
  rca: undefined as unknown,
}));

// Layout context drives the fullscreen width math (sidebar width).
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: mocks.aiPanelOpen,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    registerAiHost: () => () => {},
    sidebarCollapsed: mocks.sidebarCollapsed,
  }),
}));

// Trace fetch + stream — irrelevant to layout, stub them out.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.trace, isLoading: mocks.traceLoading, error: mocks.traceError }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: mocks.finding ? { findings: [mocks.finding] } : undefined }),
  useRca: () => ({ data: mocks.rca }),
  useTraceDetectorRuns: () => ({ data: undefined, isLoading: false, error: null }),
  useTraceDetectionState: () => ({ data: mocks.detection }),
  // Real predicate, so the test exercises the component's own gating.
  detectionInFlight: (d: { state?: string } | undefined) =>
    d?.state === "pending" || d?.state === "deciding",
}));

// Heavy children + resizable layout — replace with passthroughs so only the
// panel's own root wrapper (which carries the width class) matters.
vi.mock("./SpanTreeView", () => ({ SpanTreeView: () => null }));
vi.mock("./SpanInfoPanel", () => ({ SpanInfoPanel: () => <div data-testid="span-info" /> }));
vi.mock("./SpanTimelineView", () => ({ SpanTimelineView: () => <div data-testid="timeline" /> }));
vi.mock("./TraceDetectorsTab", () => ({
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

import { ApiError } from "@/lib/api/client";
import { TraceViewerPanel } from "./TraceViewerPanel";

function renderPanel(props: { initialFullscreen?: boolean } = {}) {
  const { container } = render(
    <TraceViewerPanel
      projectId="proj-1"
      traceId="trace-1"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp={false}
      canNavigateDown={false}
      {...props}
    />,
  );
  // The slide-in wrapper is the outermost element and carries the width class.
  return container.firstElementChild as HTMLElement;
}

afterEach(() => {
  cleanup();
  mocks.sidebarCollapsed = false;
  mocks.trace = {};
  mocks.traceError = null;
  mocks.traceLoading = false;
  mocks.aiPanelOpen = false;
  mocks.detection = undefined;
  mocks.finding = undefined;
  mocks.rca = undefined;
});

describe("TraceViewerPanel layout", () => {
  it("clears the expanded sidebar (w-48 / 12rem) when fullscreen", () => {
    mocks.sidebarCollapsed = false;
    const panel = renderPanel({ initialFullscreen: true });
    expect(panel.className).toContain("w-[calc(100%-12rem)]");
    expect(panel.className).toContain("top-14");
  });

  it("clears the collapsed sidebar (w-14 / 3.5rem) when fullscreen", () => {
    mocks.sidebarCollapsed = true;
    const panel = renderPanel({ initialFullscreen: true });
    expect(panel.className).toContain("w-[calc(100%-3.5rem)]");
  });

  it("uses the default 70% width when not fullscreen", () => {
    const panel = renderPanel({ initialFullscreen: false });
    expect(panel.className).toContain("w-[70%]");
    expect(panel.className).toContain("top-0");
  });
});

describe("TraceViewerPanel keyboard", () => {
  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <TraceViewerPanel
        projectId="proj-1"
        traceId="trace-1"
        onClose={onClose}
        onNavigate={vi.fn()}
        canNavigateUp={false}
        canNavigateDown={false}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when Escape's default was already prevented", () => {
    const onClose = vi.fn();
    render(
      <TraceViewerPanel
        projectId="proj-1"
        traceId="trace-1"
        onClose={onClose}
        onNavigate={vi.fn()}
        canNavigateUp={false}
        canNavigateDown={false}
      />,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TraceViewerPanel detectors view", () => {
  it("renders a Detectors pill in the view toggle", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: /detectors/i })).toBeTruthy();
  });

  it("renders the detectors tab even when the trace fetch failed", () => {
    // A failed/empty trace fetch must not hide the independently-loaded
    // detectors tab — it lives ahead of the isLoading/error/!trace guards.
    mocks.trace = undefined;
    mocks.traceError = new Error("boom");
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /detectors/i }));
    expect(screen.getByTestId("detectors-tab")).toBeTruthy();
  });

  it("keeps the AI panel reachable on the detectors view", () => {
    // The AI panel is a top-level sibling of the main content, so switching the
    // detail panel to the Detectors view never hides it — the agent stays
    // usable on the Detectors tab.
    mocks.aiPanelOpen = true;
    renderPanel();
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /detectors/i }));
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
  });
});

describe("TraceViewerPanel content states", () => {
  it("renders the span detail panel in tree mode", () => {
    renderPanel();
    expect(screen.getByTestId("span-info")).toBeTruthy();
  });

  it("renders the loading state while the trace is fetching", () => {
    mocks.traceLoading = true;
    renderPanel();
    expect(screen.getByText("Loading trace...")).toBeTruthy();
  });

  it("renders the error state when the trace fetch fails", () => {
    mocks.trace = undefined;
    mocks.traceError = new Error("boom");
    renderPanel();
    expect(screen.getByText("Error loading trace")).toBeTruthy();
  });

  it("renders the retention banner when the trace fetch returns 403 retention error", () => {
    mocks.trace = undefined;
    mocks.traceError = new ApiError(403, {
      message: "Data outside retention window",
      retention_days: 15,
      cutoff: "2026-06-29T00:00:00",
      plan: "free",
    });
    renderPanel();
    expect(screen.getByTestId("retention-banner")).toBeTruthy();
  });

  it("renders the timeline view in timeline mode", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /timeline/i }));
    expect(screen.getByTestId("timeline")).toBeTruthy();
  });

  it("renders the AI assistant panel when it is open", () => {
    mocks.aiPanelOpen = true;
    renderPanel();
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
  });
});

describe("TraceViewerPanel detection indicator", () => {
  it("shows a Detecting chip while detection is queued", () => {
    // Evaluation is debounced ~1min, so without this the header sits empty for
    // that whole time and the page looks idle.
    mocks.detection = { state: "pending", detectorIds: ["d1"] };
    renderPanel();
    expect(screen.getByText("Detecting…")).toBeTruthy();
  });

  it("hides the chip once the analysis is available", () => {
    // hasRca means results have landed; the Alert badge speaks for them.
    mocks.detection = { state: "pending", detectorIds: ["d1"] };
    mocks.finding = { finding_id: "f1" };
    mocks.rca = { rca: { sessionId: "s1", status: "done" } };
    renderPanel();
    expect(screen.queryByText("Detecting…")).toBeNull();
    expect(screen.getByRole("button", { name: "Alert" })).toBeTruthy();
  });

  it("shows no chip when detection is ruled out or unknown", () => {
    mocks.detection = { state: "sampled_out", detectorIds: [] };
    renderPanel();
    expect(screen.queryByText("Detecting…")).toBeNull();
  });
});
