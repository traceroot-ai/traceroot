import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));

import { fetchNextApi, fetchTraceApi } from "./client";
import { ApiError } from "./errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNextApi error classification", () => {
  it("preserves Next.js { error } responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "Detector not found" }),
      }),
    );

    const err = await fetchNextApi("/projects/p1/detectors/d1").catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("Detector not found");
    expect((err as ApiError).detail).toBe("Detector not found");
  });

  it("preserves proxied Python { detail } responses", async () => {
    const detail = {
      message: "Data outside retention window",
      retention_days: 15,
      plan: "free",
      cutoff: "x",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ detail }),
      }),
    );

    const err = await fetchNextApi("/projects/p1/detector-counts").catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).detail).toEqual(detail);
  });
});

describe("fetchTraceApi error classification", () => {
  it("throws ApiError carrying the HTTP status and backend detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ detail: "Trace not found" }),
      }),
    );

    const err = await fetchTraceApi("/x", {}, { id: "u1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("Trace not found");
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error("not json")),
      }),
    );

    const err = await fetchTraceApi("/x", {}, { id: "u1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe("Unknown error");
  });
});
