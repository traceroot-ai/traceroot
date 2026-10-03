import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readDetectorWindowSummary } from "../findings-reader.js";

const START = new Date("2026-06-01T00:00:00.000Z");
const END = new Date("2026-06-08T00:00:00.000Z");

describe("readDetectorWindowSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs detector-window-summary with project, bounds, and detector ids", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        distinct_finding_count: 1,
        data: { d1: { finding_count: 3, run_count: 9, sample_trace_ids: ["t-abc"] } },
      }),
    });

    const summary = await readDetectorWindowSummary("proj-1", START, END, {
      detectorIds: ["d1", "d2"],
    });

    expect(summary).toEqual({
      distinctFindingCount: 1,
      data: {
        d1: { finding_count: 3, run_count: 9, sample_trace_ids: ["t-abc"] },
      },
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/internal/detector-window-summary");
    const init = mockFetch.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      project_id: "proj-1",
      start_after: START.toISOString(),
      end_before: END.toISOString(),
      detector_ids: ["d1", "d2"],
      include_summaries: false,
    });
  });

  it("sends the X-Internal-Secret header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: {}, distinct_finding_count: 0 }),
    });

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

  it("passes include_summaries=true and returns sample_summaries", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        distinct_finding_count: 3,
        data: {
          d1: {
            finding_count: 3,
            run_count: 9,
            sample_trace_ids: ["t-abc"],
            sample_summaries: ["payments charge timed out 4x", "parse_invoice error swallowed"],
          },
        },
      }),
    });

    const summary = await readDetectorWindowSummary("proj-1", START, END, {
      includeSummaries: true,
    });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).include_summaries).toBe(true);
    expect(summary.data.d1.sample_summaries).toHaveLength(2);
  });

  it("defaults include_summaries to false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: {}, distinct_finding_count: 0 }),
    });
    await readDetectorWindowSummary("proj-1", START, END);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).include_summaries).toBe(false);
  });

  it("rejects a legacy response that omits distinct_finding_count", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });

    await expect(readDetectorWindowSummary("proj-1", START, END)).rejects.toThrow(
      "Invalid detector-window-summary distinct_finding_count",
    );
  });

  it.each([-1, 1.5, "1", null, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed distinct_finding_count %j",
    async (distinctFindingCount) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {}, distinct_finding_count: distinctFindingCount }),
      });

      await expect(readDetectorWindowSummary("proj-1", START, END)).rejects.toThrow(
        "Invalid detector-window-summary distinct_finding_count",
      );
    },
  );
});
