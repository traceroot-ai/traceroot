import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));

import { fetchTraceApi } from "./client";
import { TraceApiError } from "./errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTraceApi error classification", () => {
  it("throws TraceApiError carrying the HTTP status and backend detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ detail: "Trace not found" }),
      }),
    );

    const err = await fetchTraceApi("/x", {}, { id: "u1" }).catch((e) => e);
    expect(err).toBeInstanceOf(TraceApiError);
    expect((err as TraceApiError).status).toBe(404);
    expect((err as TraceApiError).message).toBe("Trace not found");
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
    expect(err).toBeInstanceOf(TraceApiError);
    expect((err as TraceApiError).status).toBe(502);
    expect((err as TraceApiError).message).toBe("Unknown error");
  });
});
