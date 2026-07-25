// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  detectorMutationErrorMessage,
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

function setup(
  response: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  } = {
    ok: true,
    status: 200,
    json: async () => ({ detector: { id: "det-1" } }),
  },
) {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
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

describe("detector mutations preserve API error messages", () => {
  it("create: throws the response error body", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 400,
      json: async () => ({
        error: "triggerConditions[0].op must be one of =, != for environment",
      }),
    });
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    result.current.mutate({ name: "n", template: "t", prompt: "p", outputSchema: [] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(
      new Error("triggerConditions[0].op must be one of =, != for environment"),
    );
  });

  it("create: does not surface trigger-looking debug response bodies", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 400,
      json: async () => ({
        error: "triggerConditions debug password=secret",
      }),
    });
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    result.current.mutate({ name: "n", template: "t", prompt: "p", outputSchema: [] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Failed to create detector: 400"));
  });

  it("update: falls back to the status message when the body has no error", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const { result } = renderHook(() => useUpdateDetector("proj-1", "det-1"), { wrapper });

    result.current.mutate({ prompt: "updated" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Failed to update detector: 500"));
  });

  it("update: does not surface unexpected server error bodies", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 500,
      json: async () => ({ error: "database password=secret stack trace" }),
    });
    const { result } = renderHook(() => useUpdateDetector("proj-1", "det-1"), { wrapper });

    result.current.mutate({ prompt: "updated" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Failed to update detector: 500"));
  });

  it("create: does not surface unknown 400 response bodies", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 400,
      json: async () => ({ error: "debug SQL fragment" }),
    });
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    result.current.mutate({ name: "n", template: "t", prompt: "p", outputSchema: [] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Failed to create detector: 400"));
  });

  it("delete: throws the response detail body", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 403,
      json: async () => ({ detail: "Admin role required to delete detectors" }),
    });
    const { result } = renderHook(() => useDeleteDetector("proj-1"), { wrapper });

    result.current.mutate("det-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Admin role required to delete detectors"));
  });

  it("delete: does not surface role-error prefixes with extra diagnostics", async () => {
    const { wrapper } = setup({
      ok: false,
      status: 403,
      json: async () => ({ detail: "Admin role required to delete detectors token=secret" }),
    });
    const { result } = renderHook(() => useDeleteDetector("proj-1"), { wrapper });

    result.current.mutate("det-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("Failed to delete detector: 403"));
  });
});

describe("detectorMutationErrorMessage", () => {
  it("formats trigger validation errors for detector UI", () => {
    expect(
      detectorMutationErrorMessage(
        new Error("triggerConditions[0].op must be one of =, != for environment"),
        "Failed to create detector",
      ),
    ).toBe("Environment filters only support = or !=.");
  });

  it("keeps non-trigger curated errors unchanged", () => {
    expect(
      detectorMutationErrorMessage(
        new Error("Admin role required to delete detectors"),
        "Failed to delete detector",
      ),
    ).toBe("Admin role required to delete detectors");
  });
});
