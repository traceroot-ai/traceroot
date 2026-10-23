// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";

// AppLayout renders the navbar button itself; everything heavy around it is
// irrelevant to the visibility logic under test.
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/traces",
}));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
const mockChatState = {
  messages: [
    { id: "m1", role: "user", content: "analyze this trace" },
    { id: "m2", role: "assistant", content: "investigating..." },
  ],
  isStreaming: true,
};

vi.mock("@/features/ai-assistant/components/ai-chat-context", () => ({
  AiChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAiChatContext: () => mockChatState,
}));

vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => {
    return (
      <div data-testid="ai-panel">
        <span data-testid="stream-status">{mockChatState.isStreaming ? "streaming" : "idle"}</span>
        <span data-testid="msg-count">{mockChatState.messages.length}</span>
      </div>
    );
  },
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { AppLayout, useLayout } from "./app-layout";

// Observability pages flip hideAiButton off in a layout effect (see
// src/app/projects/[projectId]/traces/page.tsx); mirror that here so the
// navbar button's baseline state is "shown".
function ObservabilityPageStub({ children }: { children?: React.ReactNode }) {
  const { setHideAiButton } = useLayout();
  useLayoutEffect(() => {
    setHideAiButton(false);
    return () => setHideAiButton(true);
  }, [setHideAiButton]);
  return <>{children}</>;
}

// Stand-in for TraceViewerPanel/SessionDetailPanel: claims the AI slot on
// mount, releases it on unmount or when hostId changes.
function AiHostStub({ hostId }: { hostId?: string } = {}) {
  const { registerAiHost } = useLayout();
  useEffect(() => registerAiHost(), [registerAiHost, hostId]);
  return null;
}

function renderLayout(withHost: boolean) {
  return render(
    <AppLayout>
      <ObservabilityPageStub>{withHost && <AiHostStub />}</ObservabilityPageStub>
    </AppLayout>,
  );
}

afterEach(cleanup);

describe("AppLayout navbar AI button", () => {
  it("shows the AI button on an observability page with no viewer open", () => {
    renderLayout(false);
    expect(screen.queryByTitle("AI Assistant")).not.toBeNull();
  });

  it("hides the AI button while a viewer panel owns the AI slot", () => {
    renderLayout(true);
    expect(screen.queryByTitle("AI Assistant")).toBeNull();
  });

  it("restores the AI button when the viewer panel unmounts", () => {
    const { rerender } = renderLayout(true);
    expect(screen.queryByTitle("AI Assistant")).toBeNull();
    rerender(
      <AppLayout>
        <ObservabilityPageStub />
      </AppLayout>,
    );
    expect(screen.queryByTitle("AI Assistant")).not.toBeNull();
  });
});

describe("AppLayout AI host management and assistant dismissal", () => {
  it("dismisses the assistant and clears context when an AI host unmounts", () => {
    let capturedLayout!: ReturnType<typeof useLayout>;
    function Inspector() {
      capturedLayout = useLayout();
      return null;
    }

    const { rerender } = render(
      <AppLayout>
        <Inspector />
        <AiHostStub hostId="trace-1" />
      </AppLayout>,
    );

    act(() => {
      capturedLayout.setAiPanelOpen(true);
      capturedLayout.setAiContext({ traceId: "trace-1" });
      capturedLayout.setAiInitialSessionId("session-1");
    });
    expect(capturedLayout.aiPanelOpen).toBe(true);
    expect(capturedLayout.aiContext).toEqual({ traceId: "trace-1" });
    expect(capturedLayout.aiInitialSessionId).toBe("session-1");

    // Unmount the host
    rerender(
      <AppLayout>
        <Inspector />
      </AppLayout>,
    );

    // Host unmount must close the panel and clear all AI context
    expect(capturedLayout.aiPanelOpen).toBe(false);
    expect(capturedLayout.aiContext).toBeNull();
    expect(capturedLayout.aiInitialSessionId).toBeUndefined();
  });

  it("dismisses the assistant and clears context when an AI host re-keys with a new ID", () => {
    let capturedLayout!: ReturnType<typeof useLayout>;
    function Inspector() {
      capturedLayout = useLayout();
      return null;
    }

    const { rerender } = render(
      <AppLayout>
        <Inspector />
        <AiHostStub hostId="trace-1" />
      </AppLayout>,
    );

    act(() => {
      capturedLayout.setAiPanelOpen(true);
      capturedLayout.setAiContext({ traceId: "trace-1" });
      capturedLayout.setAiInitialSessionId("session-1");
    });
    expect(capturedLayout.aiPanelOpen).toBe(true);

    // Switch to another item (trace-2)
    rerender(
      <AppLayout>
        <Inspector />
        <AiHostStub hostId="trace-2" />
      </AppLayout>,
    );

    // Re-keying releases the host slot and closes the assistant
    expect(capturedLayout.aiPanelOpen).toBe(false);
    expect(capturedLayout.aiContext).toBeNull();
    expect(capturedLayout.aiInitialSessionId).toBeUndefined();
  });

  it("preserves chat history and in-flight stream when the assistant is reopened", () => {
    let capturedLayout!: ReturnType<typeof useLayout>;
    function Inspector() {
      capturedLayout = useLayout();
      return null;
    }

    const { rerender } = render(
      <AppLayout>
        <Inspector />
        <AiHostStub hostId="trace-1" />
      </AppLayout>,
    );

    act(() => {
      capturedLayout.setAiPanelOpen(true);
    });
    expect(capturedLayout.aiPanelOpen).toBe(true);

    // Unmount the host - panel closes so it does not leak into the rail
    rerender(
      <AppLayout>
        <Inspector />
      </AppLayout>,
    );
    expect(capturedLayout.aiPanelOpen).toBe(false);
    expect(screen.queryByTestId("ai-panel")).toBeNull();

    // Reopen the assistant in the app rail
    act(() => {
      capturedLayout.setAiPanelOpen(true);
    });
    expect(capturedLayout.aiPanelOpen).toBe(true);

    // Panel is mounted in the rail and previous chat history + in-flight stream are intact
    expect(screen.getByTestId("ai-panel")).toBeDefined();
    expect(screen.getByTestId("stream-status").textContent).toBe("streaming");
    expect(screen.getByTestId("msg-count").textContent).toBe("2");
  });
});
