// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { ApiError } from "@/lib/api/client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => fetchMock.mockReset());
afterEach(cleanup);

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useDetectorCounts error path", () => {
  it("exposes an ApiError when the fetch returns 403 retention error", async () => {
    const detail = {
      message: "Data outside retention window",
      retention_days: 15,
      plan: "free",
      cutoff: "x",
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ detail }),
    });

    const { useDetectorCounts } = await import("./use-detectors");
    const { result } = renderHook(
      () => useDetectorCounts("proj-1", { start_after: "2026-01-01T00:00:00Z" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
    expect((result.current.error as ApiError).detail).toEqual(detail);
  });

  it("falls back to text detail when JSON parse fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    });

    const { useDetectorCounts } = await import("./use-detectors");
    const { result } = renderHook(
      () => useDetectorCounts("proj-1", { start_after: "2026-01-01T00:00:00Z" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(500);
  });
});

describe("useDetectorList error path", () => {
  it("exposes an ApiError when the fetch returns 403", async () => {
    const detail = {
      message: "Data outside retention window",
      retention_days: 15,
      plan: "free",
      cutoff: "x",
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ detail }),
    });

    const { useDetectorList } = await import("./use-detectors");
    const { result } = renderHook(() => useDetectorList("proj-1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
    expect((result.current.error as ApiError).detail).toEqual(detail);
  });

  it("falls back to a text detail when JSON parse fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    });

    const { useDetectorList } = await import("./use-detectors");
    const { result } = renderHook(() => useDetectorList("proj-1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(500);
  });
});

describe("useCreateDetector error path", () => {
  it("extracts error message from response json on failure and carries HTTP status in ApiError", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "A detector with this name already exists" }),
    });

    const { useCreateDetector } = await import("./use-detectors");
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    let thrown: ApiError | null = null;
    try {
      await result.current.mutateAsync({ name: "Failure Detector" } as never);
    } catch (e) {
      thrown = e as ApiError;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown?.status).toBe(409);
    expect(thrown?.message).toBe("A detector with this name already exists");
  });

  it("ignores non-string detail arrays and falls back to status message", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ detail: [{ loc: ["body", "name"], msg: "field required" }] }),
    });

    const { useCreateDetector } = await import("./use-detectors");
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    let thrown: ApiError | null = null;
    try {
      await result.current.mutateAsync({ name: "Failure Detector" } as never);
    } catch (e) {
      thrown = e as ApiError;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown?.status).toBe(422);
    expect(thrown?.message).toBe("Failed to create detector: 422");
  });

  it("falls back to status message when json parsing fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    });

    const { useCreateDetector } = await import("./use-detectors");
    const { result } = renderHook(() => useCreateDetector("proj-1"), { wrapper });

    let thrown: ApiError | null = null;
    try {
      await result.current.mutateAsync({ name: "Failure Detector" } as never);
    } catch (e) {
      thrown = e as ApiError;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown?.status).toBe(500);
    expect(thrown?.message).toBe("Failed to create detector: 500");
  });
});

describe("useUpdateDetector error path", () => {
  it("extracts error message and carries HTTP status in ApiError", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "A detector with this name already exists" }),
    });

    const { useUpdateDetector } = await import("./use-detectors");
    const { result } = renderHook(() => useUpdateDetector("proj-1", "det-1"), { wrapper });

    let thrown: ApiError | null = null;
    try {
      await result.current.mutateAsync({ name: "Failure Detector" } as never);
    } catch (e) {
      thrown = e as ApiError;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown?.status).toBe(409);
    expect(thrown?.message).toBe("A detector with this name already exists");
  });
});
