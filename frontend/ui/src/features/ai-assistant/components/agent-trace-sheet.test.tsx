// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { useLayout, LayoutContext } from "@/components/layout/app-layout";

// A minimal stand-in for the real TraceViewerPanel: it only needs to read
// `useLayout()` the same way the real component does, so this test can prove
// AgentTraceSheet's local LayoutContext.Provider actually intercepts that read
// rather than asserting on TraceViewerPanel's (unrelated, heavy) internals.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: (props: { source?: string }) => {
    const layout = useLayout();
    layout.registerAiHost();
    return (
      <div
        data-testid="trace-panel"
        data-source={props.source}
        data-ai-panel-open={String(layout.aiPanelOpen)}
      />
    );
  },
}));

import { AgentTraceSheet } from "./agent-trace-sheet";

afterEach(() => {
  cleanup();
});

describe("AgentTraceSheet", () => {
  it("neither claims the AI slot nor forwards aiPanelOpen to the nested viewer it hosts", () => {
    const registerAiHost = vi.fn(() => () => {});
    const outerLayout = {
      sidebarCollapsed: false,
      setSidebarCollapsed: vi.fn(),
      headerContent: null,
      setHeaderContent: vi.fn(),
      // Deliberately true: this is the state a real host page would be in
      // (assistant panel already open) while the user clicks "View trace".
      aiPanelOpen: true,
      setAiPanelOpen: vi.fn(),
      aiContext: null,
      setAiContext: vi.fn(),
      aiInitialSessionId: undefined,
      setAiInitialSessionId: vi.fn(),
      hideAiButton: false,
      setHideAiButton: vi.fn(),
      viewerOwnsAiSlot: false,
      registerAiHost,
    };

    render(
      <LayoutContext.Provider value={outerLayout}>
        <AgentTraceSheet projectId="proj-1" traceId="trace-1" onClose={vi.fn()} />
      </LayoutContext.Provider>,
    );

    // The sheet's content renders...
    const panel = screen.getByTestId("trace-panel");
    expect(panel.getAttribute("data-source")).toBe("agent");
    // ...but the outer (real) registerAiHost is never reached: the sheet must
    // not hide the assistant panel it lives inside by claiming the AI slot.
    expect(registerAiHost).not.toHaveBeenCalled();
    // ...and the nested viewer never sees aiPanelOpen: true, so it never
    // mounts a nested AiAssistantPanel of its own.
    expect(panel.getAttribute("data-ai-panel-open")).toBe("false");
  });

  it("renders nothing when traceId is null", () => {
    render(<AgentTraceSheet projectId="proj-1" traceId={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});
