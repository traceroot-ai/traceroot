// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useAllDetectorNames,
  useCreateDetector,
  useUpdateDetector,
  useDeleteDetector,
} from "./use-detectors";

class FakeBroadcastChannel {
  static posted: unknown[] = [];
  constructor(public name: string) {}
  postMessage(data: unknown) {
    FakeBroadcastChannel.posted.push(data);
  }
  addEventListener() {}
  close() {}
}

afterEach(() => {
  FakeBroadcastChannel.posted = [];
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ detector: { id: "det-1" } }),
    }),
  );
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidateSpy };
}

// The detector lists, and the Signals page's setup check for this project.
const expectNotified = (invalidateSpy: MockInstance) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["detectors"] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["signals", "setup", "proj-1"] });
  expect(FakeBroadcastChannel.posted).toEqual([
    { type: "invalidate", queryKey: ["detectors"] },
    { type: "invalidate", queryKey: ["signals", "setup", "proj-1"] },
  ]);
};

describe("useAllDetectorNames", () => {
  it("fetches just the first page when every detector fits in it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "d1", name: "A" },
          { id: "d2", name: "B" },
        ],
        meta: { page: 0, limit: 200, total: 2 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAllDetectorNames("proj-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual([
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ]);
  });

  it("pages through the rest when a project has more detectors than one page", async () => {
    // The real endpoint caps limit at 200; `meta.total` here (401) forces 3 pages.
    const pageBody = (page: string | null) => {
      if (page === "0") return { data: [{ id: "d1", name: "A" }], meta: { total: 401 } };
      if (page === "1") return { data: [{ id: "d2", name: "B" }], meta: { total: 401 } };
      return { data: [{ id: "d3", name: "C" }], meta: { total: 401 } };
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const page = new URL(url, "http://local").searchParams.get("page");
      return Promise.resolve({ ok: true, status: 200, json: async () => pageBody(page) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAllDetectorNames("proj-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.data?.map((d) => d.id).sort()).toEqual(["d1", "d2", "d3"]);
  });
});

describe("detector mutations notify other tabs on success", () => {
  it("update: invalidates locally and broadcasts", async () => {
    const { wrapper, invalidateSpy } = setup();
    const { result } = renderHook(() => useUpdateDetector("proj-1", "det-1"), { wrapper });
    result.current.mutate({ enableRca: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expectNotified(invalidateSpy);
  });

  it("create: invalidates locally and broadcasts", async () => {
    const { wrapper, invalidateSpy } = setup();
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });
    result.current.mutate({ name: "n", template: "t", prompt: "p", outputSchema: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expectNotified(invalidateSpy);
  });

  it("delete: invalidates locally and broadcasts", async () => {
    const { wrapper, invalidateSpy } = setup();
    const { result } = renderHook(() => useDeleteDetector("proj-1"), { wrapper });
    result.current.mutate("det-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expectNotified(invalidateSpy);
  });
});
