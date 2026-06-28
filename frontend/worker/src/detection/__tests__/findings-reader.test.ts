import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readDetectorCounts, readLatestFinding } from "../findings-reader.js";

const START = new Date("2026-06-01T00:00:00.000Z");
const END = new Date("2026-06-08T00:00:00.000Z");

describe("readDetectorCounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GETs detector-counts with project_id and window bounds, returns the data map", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { d1: { finding_count: 3, run_count: 9 } } }),
    });

    const counts = await readDetectorCounts("proj-1", START, END);

    expect(counts).toEqual({ d1: { finding_count: 3, run_count: 9 } });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/internal/detector-counts");
    expect(url).toContain("project_id=proj-1");
    expect(url).toContain(`start_after=${encodeURIComponent(START.toISOString())}`);
    expect(url).toContain(`end_before=${encodeURIComponent(END.toISOString())}`);
  });

  it("sends the X-Internal-Secret header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });

    await readDetectorCounts("proj-1", START, END);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).toHaveProperty("X-Internal-Secret");
  });

  it("throws on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    await expect(readDetectorCounts("proj-1", START, END)).rejects.toThrow(
      "Backend API error: 500",
    );
  });
});

describe("readLatestFinding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GETs detector-findings and returns the newest finding's trace id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ trace_id: "t-abc", summary: "..." }],
        meta: { total: 3 },
      }),
    });

    const traceId = await readLatestFinding("proj-1", "d1", START, END);

    expect(traceId).toBe("t-abc");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/internal/detector-findings");
    expect(url).toContain("project_id=proj-1");
    expect(url).toContain("detector_id=d1");
    expect(url).toContain("page=0");
    expect(url).toContain("limit=1");
  });

  it("returns null when there are no findings in the window", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], meta: { total: 0 } }),
    });

    const traceId = await readLatestFinding("proj-1", "d1", START, END);

    expect(traceId).toBeNull();
  });
});
