// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sidebarCollapsed: false,
  traceFindingsData: undefined as { findings: Array<{ finding_id: string }> } | undefined,
  rcaData: undefined as
    | {
        rca: {
          id: string;
          findingId: string;
          sessionId: string | null;
          status: "pending" | "running" | "done" | "failed";
          result: string | null;
          completedAt: string | null;
          createTime: string;
        } | null;
      }
    | undefined,
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
  setAiInitialSessionId: vi.fn(),
}));

// Layout context drives the fullscreen width math (sidebar width).
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: mocks.setAiPanelOpen,
    setAiContext: mocks.setAiContext,
    setAiInitialSessionId: mocks.setAiInitialSessionId,
    registerAiHost: () => () => {},
    sidebarCollapsed: mocks.sidebarCollapsed,
  }),
}));

// Trace fetch + stream — irrelevant to layout, stub them out.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: {}, isLoading: false, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/detectors/hooks/use-findings")>();
  return {
    ...actual,
    useTraceFindings: () => ({ data: mocks.traceFindingsData }),
    useRca: () => ({ data: mocks.rcaData }),
  };
});

// Heavy children + resizable layout — replace with passthroughs so only the
// panel's own root wrapper (which carries the width class) matters.
vi.mock("./SpanTreeView", () => ({ SpanTreeView: () => null }));
vi.mock("./SpanInfoPanel", () => ({ SpanInfoPanel: () => null }));
vi.mock("./SpanTimelineView", () => ({ SpanTimelineView: () => null }));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

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
  mocks.traceFindingsData = undefined;
  mocks.rcaData = undefined;
  mocks.setAiPanelOpen.mockClear();
  mocks.setAiContext.mockClear();
  mocks.setAiInitialSessionId.mockClear();
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

function setRcaStatus(status: "pending" | "running" | "done" | "failed", sessionId = "s-1") {
  mocks.traceFindingsData = { findings: [{ finding_id: "f-1" }] };
  mocks.rcaData = {
    rca: {
      id: "rca-1",
      findingId: "f-1",
      sessionId,
      status,
      result: null,
      completedAt: null,
      createTime: "2026-06-22T00:00:00.000Z",
    },
  };
}

describe("TraceViewerPanel RCA status", () => {
  it("renders queued status for pending RCA", () => {
    setRcaStatus("pending");
    renderPanel();
    expect(screen.getByText("RCA queued")).toBeTruthy();
  });

  it("renders running status for running RCA", () => {
    setRcaStatus("running");
    renderPanel();
    expect(screen.getByText("RCA running…")).toBeTruthy();
  });

  it("renders failed status for failed RCA", () => {
    setRcaStatus("failed");
    renderPanel();
    expect(screen.getByText("RCA failed")).toBeTruthy();
  });

  it("opens the RCA session when ready", () => {
    setRcaStatus("done", "session-1");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "RCA ready" }));

    expect(mocks.setAiContext).toHaveBeenCalledWith({ traceId: "trace-1" });
    expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith("session-1");
    expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true);
  });

  it("does not render an RCA control without an RCA row", () => {
    mocks.traceFindingsData = { findings: [{ finding_id: "f-1" }] };
    mocks.rcaData = { rca: null };

    renderPanel();

    expect(screen.queryByText(/RCA/)).toBeNull();
  });
});
