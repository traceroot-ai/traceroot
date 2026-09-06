// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sessionData: undefined as
    | {
        trace_count: number;
        duration_ms: number | null;
        total_input_tokens: number | null;
        total_output_tokens: number | null;
        total_cost: number | null;
        user_ids: string[];
        traces: unknown[];
      }
    | undefined,
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    registerAiHost: () => () => {},
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSession: () => ({ data: mocks.sessionData, isPending: false, error: null }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { SessionDetailPanel } from "./SessionDetailPanel";

afterEach(() => {
  cleanup();
  mocks.sessionData = undefined;
});

function renderPanel(onClose = vi.fn()) {
  render(
    <SessionDetailPanel
      projectId="proj-1"
      sessionId="session-1"
      onClose={onClose}
      onNavigate={vi.fn()}
      canNavigateUp={false}
      canNavigateDown={false}
    />,
  );
  return onClose;
}

describe("SessionDetailPanel keyboard", () => {
  it("calls onClose when Escape is pressed", () => {
    const onClose = renderPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when Escape's default was already prevented", () => {
    const onClose = renderPanel();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SessionDetailPanel metadata badges", () => {
  it("shows trace count, latency, and user links, and the empty-traces state", () => {
    mocks.sessionData = {
      trace_count: 3,
      duration_ms: 4200,
      total_input_tokens: 10,
      total_output_tokens: 20,
      total_cost: 0.05,
      user_ids: ["user-42"],
      traces: [],
    };
    renderPanel();

    expect(screen.getByText("Traces:")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Total Latency:")).toBeDefined();
    expect(screen.getByText("User:")).toBeDefined();
    expect(screen.getByText("user-42")).toBeDefined();
    expect(screen.getByText("No traces in this session")).toBeDefined();
  });
});
