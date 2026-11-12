// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import {
  ACTIVE_RUN_POLL_MS,
  useCreateLoop,
  useLoopList,
  useLoopPlanLimit,
  useLoopRuns,
  useLoopsByDetector,
  useRunLoop,
  useSetLoopStatus,
} from "./use-loops";

vi.mock("@/lib/cross-tab-sync", () => ({ broadcastQueryInvalidation: vi.fn() }));
const getWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ getWorkspace: (...a: unknown[]) => getWorkspace(...a) }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  getWorkspace.mockReset();
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

  it("turns a route error into an ApiError carrying its status and message", async () => {
    fetchMock.mockReturnValue(json({ error: "A project can have at most 5 Loops" }, 409));
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
    expect(result.current.error?.message).toBe("A project can have at most 5 Loops");
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
    const query = client.getQueryCache().findAll({ queryKey: ["loops", "runs"] })[0];
    const { refetchInterval: interval } = query.options as unknown as {
      refetchInterval: (q: { state: { data: unknown } }) => number | false;
    };
    expect(ACTIVE_RUN_POLL_MS).toBe(10_000);
    expect(interval({ state: { data: page("pending", "succeeded") } })).toBe(10_000);
    expect(interval({ state: { data: page("running") } })).toBe(10_000);
    expect(interval({ state: { data: page("succeeded", "quiet", "failed") } })).toBe(false);
    expect(interval({ state: { data: undefined } })).toBe(false);
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

  it("maps each detector id to its Loop", async () => {
    fetchMock.mockReturnValue(
      json({
        data: [{ id: "l1", name: "Coding agents", detectorId: "d1" }],
        meta: { page: 0, limit: 200, total: 1 },
      }),
    );
    const { result } = renderHook(() => useLoopsByDetector("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.get("d1")).toEqual({ id: "l1", name: "Coding agents" });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/loops?page=0&limit=200");
  });

  it("reads the Free plan's Loop limit from the workspace", async () => {
    getWorkspace.mockResolvedValue({
      loopBlocked: true,
      billingPlan: "free",
      currentUsage: { loop: { runsUsed: 30 } },
    });
    const { result } = renderHook(() => useLoopPlanLimit("ws-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      blocked: true,
      runsUsed: 30,
      included: 30,
      plan: "free",
    });
  });

  it("does not ask for a limit without a workspace", () => {
    renderHook(() => useLoopPlanLimit(undefined), { wrapper });
    expect(getWorkspace).not.toHaveBeenCalled();
  });
});
