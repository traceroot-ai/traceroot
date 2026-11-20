import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readDetectorWindowCounts, readDetectorWindowSummary } from "../findings-reader.js";

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

  it("passes include_summaries=true and returns sample_summaries", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
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

    expect(mockFetch.mock.calls[0][0]).toContain("include_summaries=true");
    expect(summary.d1.sample_summaries).toHaveLength(2);
  });

  it("omits include_summaries by default", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });
    await readDetectorWindowSummary("proj-1", START, END);
    expect(mockFetch.mock.calls[0][0]).not.toContain("include_summaries");
  });
});

describe("readDetectorWindowCounts", () => {
  beforeEach(() => vi.clearAllMocks());

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it("returns the per-detector map and the distinct finding total", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: {
          a: { finding_count: 1, run_count: 1, sample_trace_ids: ["t-1"] },
          b: { finding_count: 1, run_count: 1, sample_trace_ids: ["t-1"] },
          c: { finding_count: 1, run_count: 1, sample_trace_ids: ["t-1"] },
        },
        distinct_finding_count: 1,
      }),
    );

    const result = await readDetectorWindowCounts("proj-1", START, END);

    // Three detectors each carry the same finding: the sum is 3 but the window has 1.
    expect(Object.values(result.data).reduce((n, d) => n + d.finding_count, 0)).toBe(3);
    expect(result.distinctFindingCount).toBe(1);
  });

  it("reports a zero distinct total as 0, not as missing", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: {}, distinct_finding_count: 0 }));
    expect((await readDetectorWindowCounts("proj-1", START, END)).distinctFindingCount).toBe(0);
  });

  it("leaves the distinct total undefined when the backend predates the field", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: {} }));
    expect(
      (await readDetectorWindowCounts("proj-1", START, END)).distinctFindingCount,
    ).toBeUndefined();
  });

  it("sends the detector scope as repeated detector_ids parameters", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: {}, distinct_finding_count: 0 }));

    await readDetectorWindowCounts("proj-1", START, END, { detectorIds: ["d-a", "d b", "d-c"] });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.getAll("detector_ids")).toEqual(["d-a", "d b", "d-c"]);
    expect(url.searchParams.get("project_id")).toBe("proj-1");
  });

  it("omits detector_ids when no scope is given", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: {}, distinct_finding_count: 0 }));

    await readDetectorWindowCounts("proj-1", START, END);

    expect(new URL(mockFetch.mock.calls[0][0] as string).searchParams.has("detector_ids")).toBe(
      false,
    );
  });

  it("sends the scope and include_summaries together", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: {}, distinct_finding_count: 0 }));

    await readDetectorWindowCounts("proj-1", START, END, {
      includeSummaries: true,
      detectorIds: ["d-a"],
    });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("include_summaries")).toBe("true");
    expect(url.searchParams.getAll("detector_ids")).toEqual(["d-a"]);
  });

  it("readDetectorWindowSummary still returns just the per-detector map", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: { d1: { finding_count: 2, run_count: 4, sample_trace_ids: [] } },
        distinct_finding_count: 2,
      }),
    );
    expect(await readDetectorWindowSummary("proj-1", START, END)).toEqual({
      d1: { finding_count: 2, run_count: 4, sample_trace_ids: [] },
    });
  });

  it("throws on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" });
    await expect(readDetectorWindowCounts("proj-1", START, END)).rejects.toThrow(
      "Backend API error: 503",
    );
  });
});
