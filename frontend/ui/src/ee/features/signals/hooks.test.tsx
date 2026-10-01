// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSignal } from "./hooks";

vi.mock("@/lib/hooks/use-trace-api-user", () => ({ useTraceApiUser: () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

it("clears the previous signal while the newly selected signal is loading", async () => {
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => {
    resolveSecond = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ merged: false, signal: { id: "a" } }))
      .mockReturnValueOnce(second),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(({ id }) => useSignal("p", id, {}, "similar"), {
    initialProps: { id: "a" },
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  rerender({ id: "b" });
  expect(result.current.data).toBeUndefined();
  expect(result.current.isPending).toBe(true);
  await act(async () => resolveSecond(Response.json({ merged: false, signal: { id: "b" } })));
  await waitFor(() => expect(result.current.data).toMatchObject({ signal: { id: "b" } }));
  unmount();
  client.clear();
});
