// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { LiveToolResult, UseAIStreamOptions } from "./use-ai-stream";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  onToolResult: undefined as undefined | ((event: LiveToolResult) => void),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("./use-ai-stream", () => ({
  useAIStream: (options?: UseAIStreamOptions) => {
    mocks.onToolResult = options?.onToolResult;
    return {
      messages: [],
      isStreaming: false,
      sendMessage: vi.fn(),
      abort: vi.fn(),
      setMessages: vi.fn(),
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

/** Render the hook and make session s1 active by sending a first message. */
async function renderActiveChat() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ id: "s1" }) })),
  );
  const rendered = renderHook(() => useAiChat({ projectId: "p1" }));
  await act(() => rendered.result.current.handleSend("make a dashboard", PICK));
  return rendered;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("useAiChat dashboard auto-navigation", () => {
  it("navigates to a dashboard created in the active session's project", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });

  it("navigates for a reused (created:false) dashboard too", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ created: false }))));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p1/dashboard/db1");
  });

  it("does not navigate when the dashboard belongs to another project", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails({ projectId: "p2" }))));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate for non-dashboard resources", async () => {
    await renderActiveChat();
    for (const resourceType of ["workspace", "project", "detector", "widget"]) {
      act(() =>
        mocks.onToolResult!(toolResult(dashboardDetails({ resourceType, dashboardId: "db1" }))),
      );
    }
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate on events from a session that is no longer active", async () => {
    const { result } = await renderActiveChat();
    act(() => result.current.handleNewSession());
    act(() => mocks.onToolResult!(toolResult(dashboardDetails())));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not navigate on events from a different session's stream", async () => {
    await renderActiveChat();
    act(() => mocks.onToolResult!(toolResult(dashboardDetails(), { sessionId: "s9" })));
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
