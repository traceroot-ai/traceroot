// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import {
  loopKeys,
  useCreateLoop,
  useDeleteLoop,
  useLoop,
  useLoopList,
  useLoopMemory,
  useLoopRuns,
  useRunLoop,
  useSetLoopStatus,
} from "./use-loops";

vi.mock("@/lib/cross-tab-sync", () => ({ broadcastQueryInvalidation: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

// One client per test: a client rebuilt on every render would drop the cache the polling reads.
let client: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("use-loops", () => {
  it("lists with paging and search in the query string", async () => {
    fetchMock.mockReturnValue(json({ data: [], meta: { page: 1, limit: 10, total: 0 } }));
    const { result } = renderHook(
      () => useLoopList("p1", { page: 1, limit: 10, search_query: "daily" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/loops?page=1&limit=10&search_query=daily",
    );
  });

  it("asks nothing while disabled, as where loops are switched off", async () => {
    const { result } = renderHook(() => useLoopList("p1", { limit: 200 }, { enabled: false }), {
      wrapper,
    });
    await act(async () => {});
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a route error into an ApiError carrying its status and message", async () => {
    fetchMock.mockReturnValue(json({ error: "A project can have at most 5 loops" }, 409));
    const { result } = renderHook(() => useCreateLoop("p1"), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({
          name: "x",
          schedule: { kind: "interval", intervalHours: 6 },
          instructions: "y",
        })
        .catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(409);
    expect(result.current.error?.message).toBe("A project can have at most 5 loops");
  });

  it("posts pause and resume to the status route", async () => {
    fetchMock.mockReturnValue(json({ loop: {} }));
    const { result } = renderHook(() => useSetLoopStatus("p1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ loopId: "l1", action: "pause" });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/loops/l1/status",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "pause" }) }),
    );
  });

  it("asks to look at the runs again every 10 s while one is queued or running, and not otherwise", async () => {
    const page = (...statuses: string[]) => ({
      data: statuses.map((status, i) => ({ id: `r${i}`, status })),
      meta: { page: 0, limit: 50, total: statuses.length },
    });
    fetchMock.mockReturnValue(json(page("succeeded")));
    const { result } = renderHook(() => useLoopRuns("p1", "l1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/loops/l1/runs?page=0&limit=50");

    // The interval function the query registered, asked about different answers.
    const query = client.getQueryCache().find({ queryKey: loopKeys.runs("p1", "l1", {}) })!;
    const { refetchInterval: interval } = query.options as unknown as {
      refetchInterval: (q: { state: { data: unknown } }) => number | false;
    };
    expect(interval({ state: { data: page("pending", "succeeded") } })).toBe(10_000);
    expect(interval({ state: { data: page("running") } })).toBe(10_000);
    expect(interval({ state: { data: page("succeeded", "quiet", "failed") } })).toBe(false);
    expect(interval({ state: { data: undefined } })).toBe(false);
  });

  it("keeps looking at the runs while the loop has an active run on another page", async () => {
    fetchMock.mockReturnValue(json({ data: [], meta: { page: 1, limit: 50, total: 50 } }));
    renderHook(() => useLoopRuns("p1", "l1", { page: 1, poll: true }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const query = client
      .getQueryCache()
      .find({ queryKey: loopKeys.runs("p1", "l1", { page: 1 }) })!;
    const { refetchInterval: interval } = query.options as unknown as {
      refetchInterval: (q: { state: { data: unknown } }) => number | false;
    };
    expect(interval({ state: { data: { data: [{ id: "r1", status: "succeeded" }] } } })).toBe(
      10_000,
    );
  });

  it("looks at the loop again every 10 s while its last run is queued or running", async () => {
    fetchMock.mockReturnValue(json({ loop: { id: "l1", lastRun: null } }));
    renderHook(() => useLoop("p1", "l1"), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const query = client.getQueryCache().find({ queryKey: loopKeys.detail("p1", "l1") })!;
    const { refetchInterval: interval } = query.options as unknown as {
      refetchInterval: (q: { state: { data: unknown } }) => number | false;
    };
    const withLast = (status: string | null) => ({
      state: { data: { lastRun: status ? { status } : null } },
    });
    expect(interval(withLast("pending"))).toBe(10_000);
    expect(interval(withLast("running"))).toBe(10_000);
    expect(interval(withLast("succeeded"))).toBe(false);
    expect(interval(withLast(null))).toBe(false);
  });

  it("queues a run with a POST to the run route", async () => {
    fetchMock.mockReturnValue(json({ run: { id: "r1" } }, 201));
    const { result } = renderHook(() => useRunLoop("p1", "l1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/loops/l1/run",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reads the project's Loop memory, which all its Loops share", async () => {
    fetchMock.mockReturnValue(json({ data: [{ key: "k" }] }));
    const { result } = renderHook(() => useLoopMemory("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/loop-memory");
    expect(result.current.data).toEqual([{ key: "k" }]);
  });

  it("does not refetch the deleted loop's own reads, only the other loop reads", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/api/projects/p1/loops/l1"
        ? json({ loop: { id: "l1" } })
        : json({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    );
    const detail = renderHook(() => useLoop("p1", "l1"), { wrapper });
    const list = renderHook(() => useLoopList("p1"), { wrapper });
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    fetchMock.mockClear();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? json({ deleted: true })
        : json({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    );

    const del = renderHook(() => useDeleteLoop("p1"), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync("l1");
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/loops"));
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls.filter((u) => u === "/api/projects/p1/loops/l1")).toHaveLength(1); // the DELETE
    expect(client.getQueryState(loopKeys.detail("p1", "l1"))?.isInvalidated).toBe(true);
    // The broadcast also reaches this tab's own listener, so it names only the lists.
    expect(broadcastQueryInvalidation).toHaveBeenLastCalledWith(["loops", "list"]);
  });
});
