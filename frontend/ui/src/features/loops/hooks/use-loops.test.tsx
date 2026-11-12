// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { useCreateLoop, useLoopList, useSetLoopStatus } from "./use-loops";

vi.mock("@/lib/cross-tab-sync", () => ({ broadcastQueryInvalidation: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
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
});
