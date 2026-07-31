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

describe("useTraceFindings error path", () => {
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

    const { useTraceFindings } = await import("./use-findings");
    const { result } = renderHook(() => useTraceFindings("proj-1", "t-1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
    expect((result.current.error as ApiError).detail).toEqual(detail);
  });
});

describe("useRca error path", () => {
  it("exposes an ApiError when the fetch returns 403", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ detail: "forbidden" }),
    });

    const { useRca } = await import("./use-findings");
    const { result } = renderHook(() => useRca("proj-1", "f-1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
  });
});
