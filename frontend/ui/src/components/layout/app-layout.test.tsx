// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";

// AppLayout renders the navbar button itself; everything heavy around it is
// irrelevant to the visibility logic under test.
const mocks = vi.hoisted(() => ({ pathname: "/projects/p1/traces" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));
// A stand-in rather than `null`: whether the rail is rendered at all is the
// thing the chrome-less tests below assert on.
vi.mock("./sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
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

function renderAt(pathname: string) {
  mocks.pathname = pathname;
  return render(
    <AppLayout>
      <div data-testid="page">page</div>
    </AppLayout>,
  );
}

afterEach(() => {
  cleanup();
  mocks.pathname = "/projects/p1/traces";
});

describe("AppLayout chrome-less surfaces", () => {
  it("wraps an ordinary in-app page in the shell", () => {
    const { container } = renderAt("/projects/p1/traces");
    expect(container.querySelector("header")).not.toBeNull();
    expect(screen.queryByTestId("sidebar")).not.toBeNull();
    expect(screen.getByTestId("page")).toBeDefined();
  });

  it("renders a chrome-less surface with nothing around it", () => {
    // Everything the shell offers is a way off the page, and these surfaces
    // have one thing to do — so the page is handed through untouched. The
    // reason differs per route; see lib/chromeless-routes.
    const { container } = renderAt("/device");
    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("page")).toBeDefined();
  });

  it("renders onboarding with no shell, so it matches the surfaces around it", () => {
    // The mismatch this fixes: onboarding is the one step in the terminal
    // handoff that used to arrive wrapped in the rail, between a sign-in page
    // and a device-consent page that both render bare. The rail was also a live
    // exit from a flow holding a `?callbackUrl=` a terminal is polling on.
    const { container } = renderAt("/onboarding");
    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("page")).toBeDefined();
  });
});

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

describe("AppLayout mobile navigation", () => {
  it("keeps the permanent sidebar desktop-only and starts with the drawer closed", () => {
    const { container } = renderAt("/projects/p1/traces");
    expect(screen.queryByTestId("mobile-nav")).toBeNull();
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
    expect(container.querySelector('[data-testid="desktop-nav"]')?.className).toContain(
      "hidden md:block",
    );
  });

  it("opens the sidebar as a drawer from the header button and closes it again", () => {
    renderAt("/projects/p1/traces");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(
      screen.getByTestId("mobile-nav").querySelector('[data-testid="sidebar"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByTestId("mobile-nav")).toBeNull();
  });

  it("closes the drawer on Escape", () => {
    renderAt("/projects/p1/traces");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("mobile-nav")).toBeNull();
  });

  it("closes the drawer after navigating", () => {
    const { rerender } = renderAt("/projects/p1/traces");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    mocks.pathname = "/projects/p1/signals";
    rerender(
      <AppLayout>
        <div data-testid="page">page</div>
      </AppLayout>,
    );
    expect(screen.queryByTestId("mobile-nav")).toBeNull();
  });
});
