import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the auth client so fetchTraceApi never hits a real session lookup.
vi.mock("@/lib/auth-client", () => ({
  authClient: { getSession: vi.fn().mockResolvedValue({ data: null }) },
}));

import { getSpanIO, getTraces } from "./traces";
import type { Predicate } from "@/types/api";

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

describe("getTraces filters serialization", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("serializes filters as one URL-encoded JSON param that round-trips", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const filters: Predicate[] = [
      { field: "model_name", op: "in", value: ["claude-opus-4.8"] },
      { field: "cost", op: "gte", value: 0.5 },
    ];
    await getTraces("proj-1", "", { filters }, { id: "user-1" });

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    const raw = url.searchParams.get("filters");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(filters);
  });

  it("omits the filters param entirely when there are no filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 50, total: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getTraces("proj-1", "", { filters: [] }, { id: "user-1" });

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(url.searchParams.has("filters")).toBe(false);
  });
});
