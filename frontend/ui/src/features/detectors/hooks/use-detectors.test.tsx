// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCreateDetector, useUpdateDetector, useDeleteDetector } from "./use-detectors";

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

const expectNotified = (invalidateSpy: MockInstance) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["detectors"] });
  expect(FakeBroadcastChannel.posted).toEqual([{ type: "invalidate", queryKey: ["detectors"] }]);
};

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

describe("detector mutation errors", () => {
  it("create: surfaces backend validation messages", async () => {
    const { wrapper } = setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          error: "Selected system provider is not available for this workspace",
        },
        { status: 400 },
      ),
    );
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    await expect(
      result.current.mutateAsync({ name: "n", template: "t", prompt: "p", outputSchema: [] }),
    ).rejects.toThrow("Selected system provider is not available for this workspace");
  });

  it("update: falls back to status text when the backend error is not JSON", async () => {
    const { wrapper } = setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not json", { status: 503 }));
    const { result } = renderHook(() => useUpdateDetector("proj-1", "det-1"), { wrapper });

    await expect(result.current.mutateAsync({ enableRca: false })).rejects.toThrow(
      "Failed to update detector: 503",
    );
  });
});
