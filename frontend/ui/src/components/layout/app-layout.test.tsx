// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";

// AppLayout renders the navbar button itself; everything heavy around it is
// irrelevant to the visibility logic under test.
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/traces",
}));
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));
vi.mock("@/features/ai-assistant/components/ai-chat-context", () => ({
  AiChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
// mount, releases it on unmount.
function AiHostStub() {
  const { registerAiHost } = useLayout();
  useEffect(() => registerAiHost(), [registerAiHost]);
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
