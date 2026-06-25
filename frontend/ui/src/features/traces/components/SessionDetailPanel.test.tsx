// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// ─── hoisted mutable mock state ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sidebarCollapsed: false,
  aiPanelOpen: false,
  sessionData: {
    trace_count: 0,
    duration_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    user_ids: [],
    traces: [],
  } as {
    trace_count: number;
    duration_ms: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number | null;
    user_ids: string[];
    traces: Array<{ trace_id: string; name: string; input?: string; output?: string }>;
  } | null,
  isPending: false as boolean,
  error: null as Error | null,
}));

const layoutMocks = vi.hoisted(() => ({
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
}));

// ─── module mocks ─────────────────────────────────────────────────────────────
const mockRouterPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: mocks.aiPanelOpen,
    setAiPanelOpen: layoutMocks.setAiPanelOpen,
    setAiContext: layoutMocks.setAiContext,
    registerAiHost: () => () => {},
    sidebarCollapsed: mocks.sidebarCollapsed,
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: mocks.isPending }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSession: () => ({
    isPending: mocks.isPending,
    data: mocks.sessionData,
    error: mocks.error,
  }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: ({
    onClose,
  }: {
    projectId: string;
    compact?: boolean;
    onClose: () => void;
  }) => (
    <div data-testid="ai-assistant-panel">
      <button data-testid="ai-panel-close" onClick={onClose}>
        Close AI
      </button>
    </div>
  ),
}));

// ─── import component after mocks ────────────────────────────────────────────
import { SessionDetailPanel } from "./SessionDetailPanel";

// ─── helpers ─────────────────────────────────────────────────────────────────
const defaultProps = {
  projectId: "proj-1",
  sessionId: "sess-1",
  onClose: vi.fn(),
  onNavigate: vi.fn(),
  canNavigateUp: false,
  canNavigateDown: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.sidebarCollapsed = false;
  mocks.aiPanelOpen = false;
  mocks.isPending = false;
  mocks.error = null;
  mocks.sessionData = {
    trace_count: 0,
    duration_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    user_ids: [],
    traces: [],
  };
});

// ─── tests ────────────────────────────────────────────────────────────────────
describe("SessionDetailPanel", () => {
  // ── fullscreen toggle ──────────────────────────────────────────────────────
  it("renders the fullscreen toggle button and toggles state internally", () => {
    mocks.sidebarCollapsed = false;

    render(<SessionDetailPanel {...defaultProps} initialFullscreen={false} />);

    const expandButton = screen.getByTitle("Expand to full screen");
    expect(expandButton).toBeDefined();

    fireEvent.click(expandButton);

    const shrinkButton = screen.getByTitle("Restore default size");
    expect(shrinkButton).toBeDefined();

    fireEvent.click(shrinkButton);

    expect(screen.getByTitle("Expand to full screen")).toBeDefined();
  });

  // ── window.open ────────────────────────────────────────────────────────────
  it("renders the open in new tab button and calls window.open", () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<SessionDetailPanel {...defaultProps} />);

    const openNewTabButton = screen.getByTitle("Open in new tab");
    expect(openNewTabButton).toBeDefined();

    fireEvent.click(openNewTabButton);
    expect(windowOpenSpy).toHaveBeenCalledWith(
      expect.stringContaining("fullscreen=1"),
      "_blank",
      "noopener,noreferrer",
    );
  });

  // ── line 158: fullscreen + sidebarCollapsed CSS branch ────────────────────
  it("applies collapsed-sidebar fullscreen CSS class when sidebarCollapsed is true", () => {
    mocks.sidebarCollapsed = true;

    const { container } = render(<SessionDetailPanel {...defaultProps} initialFullscreen={true} />);

    // The outer div should contain the collapsed-sidebar width class
    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain("w-[calc(100%-3.5rem)]");
  });

  // ── lines 221-226: AI button click ────────────────────────────────────────
  it("calls setAiContext and setAiPanelOpen when AI assistant button is clicked", () => {
    mocks.sessionData = {
      trace_count: 1,
      duration_ms: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: null,
      user_ids: [],
      traces: [{ trace_id: "trace-abc", name: "test-trace" }],
    };

    render(<SessionDetailPanel {...defaultProps} />);

    const aiButton = screen.getByTitle("AI Assistant");
    fireEvent.click(aiButton);

    expect(layoutMocks.setAiContext).toHaveBeenCalledWith({
      traceId: "trace-abc",
      traceSessionId: "sess-1",
    });
    expect(layoutMocks.setAiPanelOpen).toHaveBeenCalledWith(true);
  });

  // ── lines 304-305: loading state ──────────────────────────────────────────
  it("shows loading state when isPending is true", () => {
    mocks.isPending = true;
    mocks.sessionData = null;

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByText("Loading session...")).toBeDefined();
  });

  // ── lines 308-309: error state ────────────────────────────────────────────
  it("shows error state when error is present", () => {
    mocks.error = new Error("fetch failed");
    mocks.sessionData = null;

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByText("Error loading session")).toBeDefined();
  });

  // ── lines 312-315: no data (session not found) ────────────────────────────
  it("shows 'Session not found' when data is null and not loading", () => {
    mocks.sessionData = null;

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByText("Session not found")).toBeDefined();
  });

  // ── lines 257-261: duration badge ─────────────────────────────────────────
  it("renders the Total Latency badge when duration_ms > 0", () => {
    mocks.sessionData = {
      trace_count: 1,
      duration_ms: 5000,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: null,
      user_ids: [],
      traces: [],
    };

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByText("Total Latency:")).toBeDefined();
  });

  // ── lines 275-295: user_ids list and navigation ───────────────────────────
  it("renders user_id buttons and navigates on click", () => {
    mocks.sessionData = {
      trace_count: 1,
      duration_ms: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: null,
      user_ids: ["user-42"],
      traces: [],
    };
    const onClose = vi.fn();

    render(<SessionDetailPanel {...defaultProps} onClose={onClose} />);

    // user-42 should appear
    expect(screen.getByText("user-42")).toBeDefined();

    // clicking the user button should close the panel and push a route
    const userButton = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent?.includes("user-42"))!;
    fireEvent.click(userButton);

    expect(onClose).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalled();
  });

  // ── lines 322-331: trace list (TraceCard map) ─────────────────────────────
  it("renders a TraceCard for each trace in data.traces", () => {
    mocks.sessionData = {
      trace_count: 2,
      duration_ms: null,
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cost: 0.01,
      user_ids: [],
      traces: [
        { trace_id: "tr-1", name: "Trace One", input: "hello", output: "world" },
        { trace_id: "tr-2", name: "Trace Two" },
      ],
    };

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByText("Trace One")).toBeDefined();
    expect(screen.getByText("Trace Two")).toBeDefined();
  });

  // ── lines 340-358: AI panel open — ResizableHandle + AiAssistantPanel ─────
  it("renders AI assistant panel and handle when aiPanelOpen is true", () => {
    mocks.aiPanelOpen = true;

    render(<SessionDetailPanel {...defaultProps} />);

    expect(screen.getByTestId("resizable-handle")).toBeDefined();
    expect(screen.getByTestId("ai-assistant-panel")).toBeDefined();
  });

  it("calls setAiPanelOpen(false) and setAiContext(null) when AI panel close is clicked", () => {
    mocks.aiPanelOpen = true;

    render(<SessionDetailPanel {...defaultProps} />);

    fireEvent.click(screen.getByTestId("ai-panel-close"));

    expect(layoutMocks.setAiPanelOpen).toHaveBeenCalledWith(false);
    expect(layoutMocks.setAiContext).toHaveBeenCalledWith(null);
  });

  // ── navigation buttons ─────────────────────────────────────────────────────
  it("calls onNavigate('up') when Previous session button is clicked", () => {
    const onNavigate = vi.fn();

    render(<SessionDetailPanel {...defaultProps} onNavigate={onNavigate} canNavigateUp={true} />);

    fireEvent.click(screen.getByTitle("Previous session"));
    expect(onNavigate).toHaveBeenCalledWith("up");
  });

  it("calls onNavigate('down') when Next session button is clicked", () => {
    const onNavigate = vi.fn();

    render(<SessionDetailPanel {...defaultProps} onNavigate={onNavigate} canNavigateDown={true} />);

    fireEvent.click(screen.getByTitle("Next session"));
    expect(onNavigate).toHaveBeenCalledWith("down");
  });
});
