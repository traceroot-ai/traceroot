import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopWindowStart, windowHasTraces } from "../window-traces.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const fetchMock = vi.fn();

describe("loopWindowStart", () => {
  it("starts the window lookbackHours before now", () => {
    expect(loopWindowStart(24, NOW).toISOString()).toBe("2026-11-23T12:00:00.000Z");
  });

  it("clamps the hours to 1..168, as the agent's window does", () => {
    expect(loopWindowStart(0, NOW).toISOString()).toBe("2026-11-24T11:00:00.000Z");
    expect(loopWindowStart(500, NOW).toISOString()).toBe("2026-11-17T12:00:00.000Z");
  });
});

describe("windowHasTraces", () => {
  beforeEach(() => {
    vi.stubEnv("INTERNAL_API_SECRET", "unit-test-secret");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks the trace list the agent reads for one trace since the window's start", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ trace_id: "t1" }], meta: { total: 1 } }));
    expect(await windowHasTraces("p/1", 6, NOW)).toBe(true);

    const [target, init] = fetchMock.mock.calls[0]!;
    const url = new URL(target);
    expect(url.pathname).toBe("/api/v1/projects/p%2F1/traces");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "1",
      start_after: "2026-11-24T06:00:00.000Z",
    });
    // No source or evaluation param: the route's defaults are the agent's
    // (customer traffic only, offline evaluations left out).
    expect(init.headers).toEqual({ "X-Internal-Secret": "unit-test-secret" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("says no for an empty window", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [], meta: { total: 0 } }));
    expect(await windowHasTraces("p1", 24, NOW)).toBe(false);
  });

  it("throws on a non-2xx answer or one without data", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    await expect(windowHasTraces("p1", 24, NOW)).rejects.toThrow("HTTP 503");
    fetchMock.mockResolvedValueOnce(Response.json({ detail: "x" }));
    await expect(windowHasTraces("p1", 24, NOW)).rejects.toThrow("without data");
  });
});
