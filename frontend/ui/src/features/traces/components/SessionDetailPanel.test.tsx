// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sidebarCollapsed: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    registerAiHost: () => () => {},
    sidebarCollapsed: mocks.sidebarCollapsed,
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSession: () => ({
    isPending: false,
    data: {
      trace_count: 0,
      duration_ms: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
      user_ids: [],
      traces: [],
    },
    error: null,
  }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { SessionDetailPanel } from "./SessionDetailPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.sidebarCollapsed = false;
});

describe("SessionDetailPanel", () => {
  it("renders the fullscreen toggle button and toggles state internally", () => {
    mocks.sidebarCollapsed = false;

    render(
      <SessionDetailPanel
        projectId="proj-1"
        sessionId="sess-1"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        canNavigateUp={false}
        canNavigateDown={false}
        initialFullscreen={false}
      />,
    );

    const expandButton = screen.getByTitle("Expand to full screen");
    expect(expandButton).toBeDefined();

    fireEvent.click(expandButton);

    // UI should update to show shrink button after expanding
    const shrinkButton = screen.getByTitle("Restore default size");
    expect(shrinkButton).toBeDefined();

    fireEvent.click(shrinkButton);

    // UI should return to expand button after shrinking
    expect(screen.getByTitle("Expand to full screen")).toBeDefined();
  });

  it("renders the open in new tab button and calls window.open", () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <SessionDetailPanel
        projectId="proj-1"
        sessionId="sess-1"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        canNavigateUp={false}
        canNavigateDown={false}
      />,
    );

    const openNewTabButton = screen.getByTitle("Open in new tab");
    expect(openNewTabButton).toBeDefined();

    fireEvent.click(openNewTabButton);
    expect(windowOpenSpy).toHaveBeenCalledWith(
      expect.stringContaining("fullscreen=1"),
      "_blank",
      "noopener,noreferrer",
    );
  });
});
