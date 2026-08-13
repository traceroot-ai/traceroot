// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/api/client";
import {
  isAlertGone,
  useAlert,
  useAlertCapacity,
  useAlertList,
  useCreateAlert,
  useDeleteAlert,
  useSetAlertStatus,
  useUpdateAlert,
  type AlertCreateInput,
} from "./use-alerts";

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

function setup(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidateSpy };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function nonJsonResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  };
}

const alertRow = {
  id: "a1",
  name: "high error rate",
  status: "ACTIVE",
  severity: "OK",
};

const createInput: AlertCreateInput = {
  name: "high error rate",
  view: "SPANS",
  measure: "duration",
  aggregation: "avg",
  filters: [],
  window: "10m",
  thresholdOperator: ">",
  threshold: 100,
  renotify: { mode: "OFF" },
};

const expectNotified = (invalidateSpy: MockInstance) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["alerts"] });
  expect(FakeBroadcastChannel.posted).toEqual([{ type: "invalidate", queryKey: ["alerts"] }]);
};

describe("useAlertList", () => {
  it("fetches the bare list URL when no query options are given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [alertRow], meta: { page: 0, limit: 50, total: 1 } }),
      );
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertList("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts");
    expect(result.current.data?.data).toEqual([alertRow]);
  });

  it("passes page, limit and search_query as URL params", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [], meta: { page: 2, limit: 10, total: 0 } }));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(
      () => useAlertList("p1", { page: 2, limit: 10, search_query: "cpu" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/alerts?page=2&limit=10&search_query=cpu",
    );
  });

  it("does not fetch when projectId is empty", () => {
    const fetchMock = vi.fn();
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertList(""), { wrapper });
    expect(result.current.isFetching).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's detail message as an ApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "no such project" }, 404));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertList("p1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("no such project");
  });

  it("falls back to the error field when detail is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertList("p1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).message).toBe("boom");
  });

  it("uses the fallback message when the body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(nonJsonResponse(502));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertList("p1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as ApiError;
    expect(error.status).toBe(502);
    expect(error.message).toBe("Failed to fetch alerts: 502");
  });
});

describe("useAlertCapacity", () => {
  it("selects meta.capacity from a limit=1 list fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [],
        meta: { page: 0, limit: 1, total: 3, capacity: { used: 3, max: 200 } },
      }),
    );
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertCapacity("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts?limit=1");
    expect(result.current.data).toEqual({ used: 3, max: 200 });
  });

  it("returns undefined when the response carries no capacity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [], meta: { page: 0, limit: 1, total: 0 } }));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlertCapacity("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe("useAlert", () => {
  it("fetches the detail endpoint and unwraps the alert", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ alert: alertRow }));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlert("p1", "a1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts/a1");
    expect(result.current.data).toEqual(alertRow);
  });

  it("does not fetch without an alertId", () => {
    const fetchMock = vi.fn();
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlert("p1", ""), { wrapper });
    expect(result.current.isFetching).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws an ApiError when the alert is gone", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "not found" }, 404));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useAlert("p1", "a1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isAlertGone(result.current.error)).toBe(true);
  });
});

describe("useCreateAlert", () => {
  it("POSTs the input and notifies on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ alert: alertRow }));
    const { wrapper, invalidateSpy } = setup(fetchMock);
    const { result } = renderHook(() => useCreateAlert("p1"), { wrapper });
    result.current.mutate(createInput);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInput),
    });
    expect(result.current.data).toEqual(alertRow);
    expectNotified(invalidateSpy);
  });

  it("rejects with an ApiError and does not notify on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "cap reached" }, 409));
    const { wrapper, invalidateSpy } = setup(fetchMock);
    const { result } = renderHook(() => useCreateAlert("p1"), { wrapper });
    result.current.mutate(createInput);
    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.posted).toEqual([]);
  });
});

describe("useUpdateAlert", () => {
  it("PATCHes the alert and notifies on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ alert: alertRow }));
    const { wrapper, invalidateSpy } = setup(fetchMock);
    const { result } = renderHook(() => useUpdateAlert("p1"), { wrapper });
    result.current.mutate({ alertId: "a1", input: createInput });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts/a1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInput),
    });
    expectNotified(invalidateSpy);
  });
});

describe("useDeleteAlert", () => {
  it("DELETEs the alert and notifies on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const { wrapper, invalidateSpy } = setup(fetchMock);
    const { result } = renderHook(() => useDeleteAlert("p1"), { wrapper });
    result.current.mutate("a1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts/a1", { method: "DELETE" });
    expectNotified(invalidateSpy);
  });
});

describe("useSetAlertStatus", () => {
  it("PATCHes the pause endpoint with the status and notifies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ alert: { ...alertRow, status: "PAUSED" } }));
    const { wrapper, invalidateSpy } = setup(fetchMock);
    const { result } = renderHook(() => useSetAlertStatus("p1"), { wrapper });
    result.current.mutate({ alertId: "a1", status: "PAUSED" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/alerts/a1/pause", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "PAUSED" }),
    });
    expect(result.current.data?.status).toBe("PAUSED");
    expectNotified(invalidateSpy);
  });

  it("surfaces the fallback message for a non-JSON error body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(nonJsonResponse(500));
    const { wrapper } = setup(fetchMock);
    const { result } = renderHook(() => useSetAlertStatus("p1"), { wrapper });
    result.current.mutate({ alertId: "a1", status: "ACTIVE" });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).message).toBe("Failed to update alert: 500");
  });
});

describe("isAlertGone", () => {
  it("is true for 404 and 403 ApiErrors", () => {
    expect(isAlertGone(new ApiError(404, "gone"))).toBe(true);
    expect(isAlertGone(new ApiError(403, "revoked"))).toBe(true);
  });

  it("is false for other statuses and non-ApiErrors", () => {
    expect(isAlertGone(new ApiError(500, "boom"))).toBe(false);
    expect(isAlertGone(new Error("boom"))).toBe(false);
    expect(isAlertGone(undefined)).toBe(false);
  });
});
