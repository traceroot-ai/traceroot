// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { useAiChatContext } from "@/features/ai-assistant/components/ai-chat-context";
import type { AIMessage } from "@/features/ai-assistant/types";
import type { useAiChat as useAiChatHook } from "@/features/ai-assistant/hooks/use-ai-chat";

// AppLayout renders the navbar button itself; everything heavy around it is
// irrelevant to the visibility logic under test.
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/traces",
}));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({ retentionDays: 30 }),
}));

vi.mock("@/features/ai-assistant/hooks/use-ai-chat", () => ({
  useAiChat: () => {
    const [messages, setMessages] = useState<AIMessage[]>([
      { id: "m1", role: "user", content: "analyze this trace", timestamp: "2026-01-01" },
      { id: "m2", role: "assistant", content: "investigating...", timestamp: "2026-01-01" },
    ]);
    const [isStreaming] = useState(true);
    const handleSend = async (message: string) => {
      setMessages((prev) => [
        ...prev,
        { id: "m3", role: "user", content: message, timestamp: "2026-01-01" },
      ]);
    };
    return {
      messages,
      isStreaming,
      handleSend,
    } as unknown as ReturnType<typeof useAiChatHook>;
  },
}));

function MockAiPanel() {
  const { messages, isStreaming, handleSend } = useAiChatContext();
  return (
    <div data-testid="ai-panel">
      <span data-testid="stream-status">{isStreaming ? "streaming" : "idle"}</span>
      <span data-testid="msg-count">{messages.length}</span>
      <button
        data-testid="add-msg-btn"
        onClick={() =>
          void handleSend("followup", {
            model: "",
            provider: "",
            source: "system",
            adapter: "",
          })
        }
      >
        Add
      </button>
    </div>
  );
}

vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <MockAiPanel />,
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

    // Panel is mounted in the rail and backed by the real AiChatProvider context
    expect(screen.getByTestId("ai-panel")).toBeDefined();
    expect(screen.getByTestId("stream-status").textContent).toBe("streaming");
    expect(screen.getByTestId("msg-count").textContent).toBe("2");

    // Send a message to mutate chat state in the real provider context
    fireEvent.click(screen.getByTestId("add-msg-btn"));
    expect(screen.getByTestId("msg-count").textContent).toBe("3");

    // Close the panel again (dismissal)
    act(() => {
      capturedLayout.setAiPanelOpen(false);
    });
    expect(screen.queryByTestId("ai-panel")).toBeNull();

    // Reopen the assistant and assert the mutated chat state and stream survive
    act(() => {
      capturedLayout.setAiPanelOpen(true);
    });
    expect(screen.getByTestId("ai-panel")).toBeDefined();
    expect(screen.getByTestId("stream-status").textContent).toBe("streaming");
    expect(screen.getByTestId("msg-count").textContent).toBe("3");
  });
});
