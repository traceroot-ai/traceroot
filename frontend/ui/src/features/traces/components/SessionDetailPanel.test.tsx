// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

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
  useSession: () => ({ data: undefined, isPending: false, error: null }),
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
