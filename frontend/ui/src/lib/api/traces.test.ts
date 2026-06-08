import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the auth client so fetchTraceApi never hits a real session lookup.
vi.mock("@/lib/auth-client", () => ({
  authClient: { getSession: vi.fn().mockResolvedValue({ data: null }) },
}));

import { getSpanIO } from "./traces";

describe("getSpanIO", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the per-span /io endpoint and returns the parsed body", async () => {
    const body = {
      span_id: "span-1",
      trace_id: "trace-9",
      input: "in",
      output: "out",
      metadata: "{}",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getSpanIO("proj-1", "trace-9", "span-1", {
      id: "user-1",
      email: "u@example.com",
    });

    expect(result).toEqual(body);
    // URL is built from the path params, in order.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/projects/proj-1/traces/trace-9/spans/span-1/io");
    // User identity is forwarded as headers.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-user-email"]).toBe("u@example.com");
  });

  it("throws on a non-ok response (e.g. 404 unknown span)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: "Span not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSpanIO("proj-1", "trace-9", "missing", { id: "user-1" })).rejects.toThrow(
      "Span not found",
    );
  });
});
