import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readDetectorWindowSummary } from "../findings-reader.js";

const START = new Date("2026-06-01T00:00:00.000Z");
const END = new Date("2026-06-08T00:00:00.000Z");

describe("readDetectorWindowSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GETs detector-window-summary with project_id and window bounds, returns the data map", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { d1: { finding_count: 3, run_count: 9, sample_trace_ids: ["t-abc"] } },
      }),
    });

    const summary = await readDetectorWindowSummary("proj-1", START, END);

    expect(summary).toEqual({
      d1: { finding_count: 3, run_count: 9, sample_trace_ids: ["t-abc"] },
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/internal/detector-window-summary");
    expect(url).toContain("project_id=proj-1");
    expect(url).toContain(`start_after=${encodeURIComponent(START.toISOString())}`);
    expect(url).toContain(`end_before=${encodeURIComponent(END.toISOString())}`);
  });

  it("sends the X-Internal-Secret header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });

    await readDetectorWindowSummary("proj-1", START, END);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).toHaveProperty("X-Internal-Secret");
  });

  it("throws on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    await expect(readDetectorWindowSummary("proj-1", START, END)).rejects.toThrow(
      "Backend API error: 500",
    );
  });
});
