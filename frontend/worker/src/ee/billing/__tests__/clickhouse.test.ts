import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getWorkspaceUsageDetails } from "../clickhouse.js";

describe("getWorkspaceUsageDetails", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ traces: 3, spans: 7, detector_runs: 1 }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bounds the internal API request with an AbortSignal timeout", async () => {
    const result = await getWorkspaceUsageDetails({
      projectIds: ["p1"],
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-02-01T00:00:00Z"),
    });

    expect(result).toEqual({ traces: 3, spans: 7, detectorRuns: 1 });
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("short-circuits with zero counts and no fetch when there are no project ids", async () => {
    const result = await getWorkspaceUsageDetails({
      projectIds: [],
      start: new Date(),
      end: new Date(),
    });

    expect(result).toEqual({ traces: 0, spans: 0, detectorRuns: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
