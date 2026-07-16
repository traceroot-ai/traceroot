// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e@x.dev" } }, isPending: false }),
}));
const getTraces = vi.fn();
const tracesExistMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getTraces: (...a: unknown[]) => getTraces(...a),
  getTrace: vi.fn(),
  getSpanIO: vi.fn(),
  tracesExist: (...a: unknown[]) => tracesExistMock(...a),
}));
vi.mock("@/lib/api/sessions", () => ({ getSessions: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/api/users", () => ({ getUsers: vi.fn() }));
vi.mock("./use-trace-list-state", () => ({ useTraceListState: vi.fn() }));
vi.mock("./use-trace-stream", () => ({ useTraceStream: vi.fn() }));

import { useTraces, usePrefetchTraces, useTracesExist } from "./index";

afterEach(() => {
  cleanup();
  getTraces.mockReset();
  tracesExistMock.mockReset();
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useTraces", () => {
  it("keeps previous page data on screen while the next page is fetching", async () => {
    getTraces.mockResolvedValueOnce({ data: [{ trace_id: "a" }], total: 100 });
    const { result, rerender } = renderHook(({ page }) => useTraces("p1", { page, limit: 50 }), {
      wrapper: wrapper(),
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(result.current.data?.data?.[0]?.trace_id).toBe("a"));

    let resolveNext: (v: unknown) => void = () => {};
    getTraces.mockReturnValueOnce(
      new Promise((r) => {
        resolveNext = r;
      }),
    );
    rerender({ page: 1 });

    // While page 1 is in flight, previous page's rows remain (no flash to empty).
    expect(result.current.data?.data?.[0]?.trace_id).toBe("a");
    expect(result.current.isFetching).toBe(true);

    resolveNext({ data: [{ trace_id: "b" }], total: 100 });
    await waitFor(() => expect(result.current.data?.data?.[0]?.trace_id).toBe("b"));
  });
});

describe("usePrefetchTraces", () => {
  it("prefetches the given page with the same key shape and auth user", async () => {
    getTraces.mockResolvedValue({ data: [], total: 0 });
    const { result } = renderHook(() => usePrefetchTraces("p1"), { wrapper: wrapper() });

    result.current({ page: 3, limit: 50, user_id: "u1" });

    await waitFor(() => expect(getTraces).toHaveBeenCalledTimes(1));
    expect(getTraces).toHaveBeenCalledWith(
      "p1",
      "",
      { page: 3, limit: 50, user_id: "u1" },
      { id: "u1", email: "e@x.dev" },
    );
  });

  it("does nothing without a projectId", () => {
    const { result } = renderHook(() => usePrefetchTraces(""), { wrapper: wrapper() });
    result.current({ page: 1, limit: 50 });
    expect(getTraces).not.toHaveBeenCalled();
  });
});

describe("useTracesExist", () => {
  it("returns exists: true when the project has traces", async () => {
    tracesExistMock.mockResolvedValue({ exists: true });
    const { result } = renderHook(() => useTracesExist("p1"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ exists: true });
    expect(tracesExistMock).toHaveBeenCalledWith("p1", { id: "u1", email: "e@x.dev" });
  });

  it("returns exists: false when the project has no traces", async () => {
    tracesExistMock.mockResolvedValue({ exists: false });
    const { result } = renderHook(() => useTracesExist("p1"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ exists: false });
  });

  it("does not fire when projectId is empty", () => {
    const { result } = renderHook(() => useTracesExist(""), { wrapper: wrapper() });
    expect(result.current.isFetching).toBe(false);
    expect(tracesExistMock).not.toHaveBeenCalled();
  });
});
