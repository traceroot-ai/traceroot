// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { rcaInProgress, useRequestSignalRca, useSignal, useSignals } from "./hooks";

vi.mock("@/lib/hooks/use-trace-api-user", () => ({ useTraceApiUser: () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

it("clears the previous signal while the newly selected signal is loading", async () => {
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ merged: false, signal: { id: "a", rca: { currentState: null } } }),
    )
    .mockReturnValueOnce(second);
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(({ id }) => useSignal("p", id, {}, "similar"), {
    initialProps: { id: "a" },
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^\/api\/projects\/p\/signals\/a\?tz=[^&]+&population=similar$/),
  );
  rerender({ id: "b" });
  expect(result.current.data).toBeUndefined();
  expect(result.current.isPending).toBe(true);
  await act(async () =>
    resolveSecond(
      Response.json({ merged: false, signal: { id: "b", rca: { currentState: null } } }),
    ),
  );
  await waitFor(() => expect(result.current.data).toMatchObject({ signal: { id: "b" } }));
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    expect.stringMatching(/^\/api\/projects\/p\/signals\/b\?tz=[^&]+&population=similar$/),
  );
  unmount();
  client.clear();
});

it("drops the previous project's placeholder rows when the project changes", async () => {
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: "a" }], meta: { page: 0, limit: 20, total: 1 } }),
    )
    .mockReturnValueOnce(second);
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(({ projectId }) => useSignals(projectId, {}), {
    initialProps: { projectId: "p1" },
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  // Switching to a different project must not show p1's rows as a placeholder.
  rerender({ projectId: "p2" });
  expect(result.current.data).toBeUndefined();
  expect(result.current.isPlaceholderData).toBe(false);

  await act(async () =>
    resolveSecond(Response.json({ data: [{ id: "b" }], meta: { page: 0, limit: 20, total: 1 } })),
  );
  await waitFor(() => expect(result.current.data?.data[0].id).toBe("b"));
  unmount();
  client.clear();
});

it("keeps the signal on screen while a new time window loads", async () => {
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ merged: false, signal: { id: "a", rca: { currentState: null } } }),
    )
    .mockReturnValueOnce(second);
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ start }) => useSignal("p", "a", { startAfter: start }, "similar"),
    { initialProps: { start: "2026-09-25T00:00:00.000Z" }, wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  rerender({ start: "2026-09-01T00:00:00.000Z" });
  // The panel keeps the previous answer instead of blanking while the new window loads.
  expect(result.current.data).toMatchObject({ signal: { id: "a" } });
  expect(result.current.isPlaceholderData).toBe(true);
  expect(result.current.isPending).toBe(false);
  await act(async () =>
    resolveSecond(
      Response.json({ merged: false, signal: { id: "a", rca: { currentState: "done" } } }),
    ),
  );
  await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  expect(fetchMock.mock.calls[1][0]).toContain("start_after=2026-09-01");
  unmount();
  client.clear();
});

it("treats a waiting or running analysis as in progress", () => {
  expect(rcaInProgress("pending")).toBe(true);
  expect(rcaInProgress("running")).toBe(true);
  expect(rcaInProgress("failed")).toBe(false);
  expect(rcaInProgress(null)).toBe(false);
});

it("asks for a signal's analysis and rereads the signal", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "pending" }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useRequestSignalRca("p", "s"), { wrapper });
  await act(async () => {
    await result.current.mutateAsync();
  });
  expect(fetchMock).toHaveBeenCalledWith("/api/projects/p/signals/s/rca", { method: "POST" });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["signals", "byId", "p"] });
});
