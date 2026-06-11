// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sidebarCollapsed: false,
}));

// Layout context drives the fullscreen width math (sidebar width).
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
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
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: undefined }),
  useRca: () => ({ data: undefined }),
}));

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
