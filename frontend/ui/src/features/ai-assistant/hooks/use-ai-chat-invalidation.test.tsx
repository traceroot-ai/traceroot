// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LiveToolResult, UseAIStreamOptions } from "./use-ai-stream";

// The panel must never navigate on agent writes — cache invalidation alone
// surfaces created resources. The router mock stays observable so the tests
// can assert it is untouched (and catch any reintroduction via useRouter).
const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

// Captures the options useAiChat hands the stream so the test can drive
// onToolResult directly, exactly as a live tool_execution_end would.
const stream = vi.hoisted(() => ({ options: undefined as UseAIStreamOptions | undefined }));

vi.mock("./use-ai-stream", () => ({
  useAIStream: (options: UseAIStreamOptions) => {
    stream.options = options;
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

const PANEL_PROJECT = "p1";
const PANEL_SESSION = "s1";

let queryClient: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Query keys the hook invalidated, in call order. */
function invalidatedKeys(): unknown[] {
  return invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
}

function emitToolResult(result: unknown, overrides: Partial<LiveToolResult> = {}) {
  act(() => {
    stream.options?.onToolResult?.({
      sessionId: PANEL_SESSION,
      projectId: PANEL_PROJECT,
      result,
      isError: false,
      ...overrides,
    });
  });
}

const dashboardResult = (overrides: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: 'Created dashboard "Overview" (id db1)' }],
  details: {
    kind: "resource_created",
    resourceType: "dashboard",
    resourceId: "db1",
    created: true,
    projectId: PANEL_PROJECT,
    ...overrides,
  },
});

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(queryClient, "invalidateQueries");
  stream.options = undefined;
  // A hoisted vi.fn() outlives restoreAllMocks, so its calls would accumulate
  // across tests and pin the navigation assertion on the wrong one.
  routerPush.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useAiChat cache invalidation on agent writes", () => {
  it("stales the dashboards list as soon as the tool result arrives", () => {
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult(dashboardResult());
    expect(invalidatedKeys()).toEqual([
      ["dashboards", PANEL_PROJECT],
      ["dashboard", PANEL_PROJECT, "db1"],
    ]);
  });

  it("stales the list and the parent dashboard when the agent adds a widget", () => {
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult(
      dashboardResult({ resourceType: "widget", resourceId: "w1", dashboardId: "db1" }),
    );
    // The placement write bumps the dashboard's update time, which the list
    // displays — both go stale.
    expect(invalidatedKeys()).toEqual([
      ["dashboards", PANEL_PROJECT],
      ["dashboard", PANEL_PROJECT, "db1"],
    ]);
  });

  it("stales the detectors key when the agent creates a detector", () => {
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult(dashboardResult({ resourceType: "detector", resourceId: "d1" }));
    expect(invalidatedKeys()).toEqual([["detectors"]]);
  });

  it("stales nothing when the result carries no usable details", () => {
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult({ content: [{ type: "text", text: "12 traces matched" }] });
    emitToolResult({ details: "nope" });
    emitToolResult(undefined);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("stales the OTHER project's keys for a background session's write", () => {
    // Navigation is guarded to the panel's own session/project; invalidation is
    // not — a background write still leaves that project's cache stale.
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult(dashboardResult({ projectId: "p2" }), {
      sessionId: "s2",
      projectId: "p2",
    });
    expect(invalidatedKeys()).toEqual([
      ["dashboards", "p2"],
      ["dashboard", "p2", "db1"],
    ]);
  });

  it("does not navigate when a turn that created a dashboard completes", async () => {
    // Session s1 is active (a send committed it) and the panel is on the same
    // project — the exact case the old auto-navigation fired for. Invalidation
    // above is what surfaces the dashboard; the router must stay untouched.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: PANEL_SESSION }) })),
    );
    const { result } = renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    await act(() =>
      result.current.handleSend("make a dashboard", {
        model: "m",
        provider: "p",
        source: "system",
        adapter: "a",
      }),
    );
    emitToolResult(dashboardResult());
    // The stream offers no turn-completion hook to defer a navigation onto,
    // and the router was never touched at any point of the flow.
    expect(stream.options && "onTurnComplete" in stream.options).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stales per tool result rather than waiting for the turn to finish", () => {
    renderHook(() => useAiChat({ projectId: PANEL_PROJECT }), { wrapper });
    emitToolResult(dashboardResult());
    // The user must see the dashboard appear while the agent is still adding
    // widgets, so the invalidation cannot wait for the turn to end.
    expect(invalidate).toHaveBeenCalled();
  });
});
