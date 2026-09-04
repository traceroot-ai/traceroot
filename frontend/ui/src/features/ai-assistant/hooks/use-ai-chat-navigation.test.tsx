// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LiveToolResult, TurnCompletion, UseAIStreamOptions } from "./use-ai-stream";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  onToolResult: undefined as undefined | ((event: LiveToolResult) => void),
  onTurnComplete: undefined as undefined | ((event: TurnCompletion) => void),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("./use-ai-stream", () => ({
  useAIStream: (options?: UseAIStreamOptions) => {
    mocks.onToolResult = options?.onToolResult;
    mocks.onTurnComplete = options?.onTurnComplete;
    return {
      messagesBySession: {},
      streamingSessions: {},
      isSessionStreaming: () => false,
      sendMessage: vi.fn(),
      setSessionMessages: vi.fn(),
      abortSession: vi.fn(),
      abortAll: vi.fn(),
      clearAll: vi.fn(),
      removeSession: vi.fn(),
    };
  },
}));

import { useAiChat } from "./use-ai-chat";

const PICK = { model: "m", provider: "p", source: "system" as const, adapter: "a" };

function toolResult(details: Record<string, unknown>, origin: Partial<LiveToolResult> = {}) {
  return {
    sessionId: "s1",
    projectId: "p1",
    isError: false,
    result: { content: [], details },
    ...origin,
  };
}

const dashboardDetails = (overrides: Record<string, unknown> = {}) => ({
  kind: "resource_created",
  resourceType: "dashboard",
  resourceId: "db1",
  created: true,
  projectId: "p1",
  ...overrides,
});

// The hook invalidates the react-query cache on write results, so it needs a
// client in scope; navigation behavior is independent of it.
const queryClient = new QueryClient();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Complete session s1's turn (the deferred-navigation fire point). */
function endTurn(overrides: Partial<TurnCompletion> = {}) {
  act(() => mocks.onTurnComplete!({ sessionId: "s1", projectId: "p1", ...overrides }));
}

/** Render the hook and make session s1 active by sending a first message. */
async function renderActiveChat() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ id: "s1" }) })),
  );
  const rendered = renderHook(() => useAiChat({ projectId: "p1" }), { wrapper });
  await act(() => rendered.result.current.handleSend("make a dashboard", PICK));
  return rendered;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("useAiChat dashboard auto-navigation", () => {
  it("defers navigation to the end of the turn, then fires exactly once", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    // Mid-turn (the agent may still be adding widgets): no navigation yet.
    expect(mocks.push).not.toHaveBeenCalled();
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
    // A later turn with no new dashboard must not replay the navigation.
    endTurn();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("navigates for a reused (created:false) dashboard too", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ created: false }))));
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });

  it("navigates once, to the last dashboard, when a turn creates several", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ resourceId: "db2" }))));
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db2");
  });

  it("keeps the pending navigation across later non-dashboard tool results", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ resourceType: "widget" }))));
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });

  it("does not navigate when the dashboard belongs to another project", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ projectId: "p2" }))));
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate for non-dashboard resources", async () => {
    await renderActiveChat();
    for (const resourceType of ["workspace", "project", "detector", "widget"]) {
      act(() =>
        mocks.onToolResult!(toolResult(dashboardDetails({ resourceType, dashboardId: "db1" }))),
      );
    }
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate when the session is no longer active at turn completion", async () => {
    const { result } = await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    act(() => result.current.handleNewSession());
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate when the user switched to another session before completion", async () => {
    const { result } = await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    await act(() =>
      result.current.handleSelectSession({ id: "s2" } as Parameters<
        typeof result.current.handleSelectSession
      >[0]),
    );
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("drops the pending navigation on abort", async () => {
    const { result } = await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    act(() => result.current.handleAbort());
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("drops the pending navigation when the panel is closed", async () => {
    const { result } = await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    act(() => result.current.handleClose());
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate after the panel moves to another project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: "s1" }) })),
    );
    const { result, rerender } = renderHook(({ projectId }) => useAiChat({ projectId }), {
      initialProps: { projectId: "p1" },
      wrapper,
    });
    await act(() => result.current.handleSend("make a dashboard", PICK));
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    rerender({ projectId: "p2" });
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate on events from a different session's stream", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails(), { sessionId: "s9" })));
    endTurn();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate when a different session's turn completes", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    endTurn({ sessionId: "s9" });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("still navigates after a background session's turn completes first", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    // Another session finishing must not consume s1's pending navigation.
    endTurn({ sessionId: "s9" });
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });

  it("keeps the active session's navigation when a background session creates a dashboard", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    // A background session's create lands in its own slot, not over s1's.
    act(() =>
      mocks.onToolResult!(toolResult(dashboardDetails({ resourceId: "db2" }), { sessionId: "s9" })),
    );
    endTurn();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });
});
