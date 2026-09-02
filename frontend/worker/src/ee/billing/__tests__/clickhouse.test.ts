import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceUsageDetails } from "../clickhouse.js";

// getWorkspaceUsageDetails talks to the internal REST API over fetch; stub the
// transport to pin the request contract and the by_source merge semantics.
function stubFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const WINDOW = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-02-01T00:00:00Z") };

describe("getWorkspaceUsageDetails", () => {
  it("returns zeros with an all-zero breakdown for a workspace with no projects, without calling the API", async () => {
    const fetchMock = stubFetch({});

    const usage = await getWorkspaceUsageDetails({ projectIds: [], ...WINDOW });

    expect(usage).toEqual({
      traces: 0,
      spans: 0,
      detectorRuns: 0,
      bySource: {
        user: { traces: 0, spans: 0 },
        detector: { traces: 0, spans: 0 },
        agent: { traces: 0, spans: 0 },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills an all-zero breakdown when the backend predates by_source", async () => {
    stubFetch({ traces: 7, spans: 70, detector_runs: 3 });

    const usage = await getWorkspaceUsageDetails({ projectIds: ["p1"], ...WINDOW });

    expect(usage.traces).toBe(7);
    expect(usage.detectorRuns).toBe(3);
    expect(usage.bySource).toEqual({
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    });
  });

  it("merges a partial by_source over zeros so a missing bucket reads 0, not undefined", async () => {
    stubFetch({
      traces: 12,
      spans: 120,
      detector_runs: 4,
      by_source: { user: { traces: 10, spans: 100 }, agent: { traces: 2, spans: 20 } },
    });

    const usage = await getWorkspaceUsageDetails({ projectIds: ["p1", "p2"], ...WINDOW });

    expect(usage.bySource.user).toEqual({ traces: 10, spans: 100 });
    expect(usage.bySource.agent).toEqual({ traces: 2, spans: 20 });
    expect(usage.bySource.detector).toEqual({ traces: 0, spans: 0 });
  });

  it("defaults detector_runs to 0 when the backend omits it", async () => {
    stubFetch({ traces: 1, spans: 2 });

    const usage = await getWorkspaceUsageDetails({ projectIds: ["p1"], ...WINDOW });

    expect(usage.detectorRuns).toBe(0);
  });
});
