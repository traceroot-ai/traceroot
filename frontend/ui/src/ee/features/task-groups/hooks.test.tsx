// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useRefreshTaskGroups,
  useTaskGroups,
  useTraceTaskGroups,
  useUpdateTaskGroupSettings,
} from "./hooks";

const mockFetch = vi.fn();
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

const ok = (body: unknown, status = 200) =>
  Promise.resolve({ ok: true, status, json: async () => body });
const fail = (status: number, body: unknown = {}) =>
  Promise.resolve({ ok: false, status, json: async () => body });

describe("useTaskGroups", () => {
  it("reads the overview for the project and range", async () => {
    mockFetch.mockReturnValue(ok({ groups: [] }));
    const { result } = renderHook(
      () =>
        useTaskGroups("p1", {
          startAfter: "2026-11-01T00:00:00Z",
          endBefore: "2026-11-08T00:00:00Z",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain("/api/projects/p1/task-groups?");
    expect(url).toContain("start_after=2026-11-01T00%3A00%3A00Z");
    expect(url).toContain("end_before=2026-11-08T00%3A00%3A00Z");
  });

  it("surfaces the server's message on failure", async () => {
    mockFetch.mockReturnValue(fail(502, { error: "Could not load topics" }));
    const { result } = renderHook(() => useTaskGroups("p1", {}), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Could not load topics");
  });
});

describe("useUpdateTaskGroupSettings", () => {
  it("PUTs the change and refreshes the overview afterwards", async () => {
    mockFetch.mockReturnValue(ok({ enabled: true, dailyCostCapUsd: 1 }));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useUpdateTaskGroupSettings("p1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ enabled: true });
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/projects/p1/task-groups/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["task-groups"] });
  });

  it("reports a refusal with the server's words", async () => {
    mockFetch.mockReturnValue(fail(403, { error: "Not available in the demo workspace" }));
    const { result } = renderHook(() => useUpdateTaskGroupSettings("p1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ enabled: true }).catch(() => {});
    });
    await waitFor(() =>
      expect(result.current.error?.message).toBe("Not available in the demo workspace"),
    );
  });
});

describe("useRefreshTaskGroups", () => {
  it("POSTs a refresh request", async () => {
    mockFetch.mockReturnValue(ok({ accepted: true }, 202));
    const { result } = renderHook(() => useRefreshTaskGroups("p1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/projects/p1/task-groups/refresh");
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
  });

  it("surfaces the rate limit message", async () => {
    mockFetch.mockReturnValue(fail(429, { error: "Refresh was asked for recently" }));
    const { result } = renderHook(() => useRefreshTaskGroups("p1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync().catch(() => {});
    });
    await waitFor(() =>
      expect(result.current.error?.message).toBe("Refresh was asked for recently"),
    );
  });
});

describe("useTraceTaskGroups", () => {
  it("asks only when enabled and there are traces", () => {
    renderHook(() => useTraceTaskGroups("p1", [], true), { wrapper });
    renderHook(() => useTraceTaskGroups("p1", ["t1"], false), { wrapper });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends each trace id and returns the groups", async () => {
    mockFetch.mockReturnValue(ok({ groups: { t1: { groupId: "g1", name: "Refunds" } } }));
    const { result } = renderHook(() => useTraceTaskGroups("p1", ["t1", "t2"], true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(mockFetch.mock.calls[0][0])).toContain("trace_id=t1&trace_id=t2");
    expect(result.current.data?.groups.t1.name).toBe("Refunds");
  });
});
