import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceUsageDetails } from "../clickhouse.js";

// getWorkspaceUsageDetails talks to the internal REST API over fetch; stub the
// transport to pin the request contract (path, query, auth header) and the
// response mapping.
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

  it("requests /usage/details with the project ids, ISO window and internal secret, and maps the response", async () => {
    const bySource = {
      user: { traces: 10, spans: 100 },
      detector: { traces: 2, spans: 20 },
      agent: { traces: 0, spans: 0 },
    };
    const fetchMock = stubFetch({ traces: 12, spans: 120, detector_runs: 4, by_source: bySource });

    const usage = await getWorkspaceUsageDetails({ projectIds: ["p1", "p2"], ...WINDOW });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/internal/usage/details");
    expect(parsed.searchParams.get("project_ids")).toBe("p1,p2");
    expect(parsed.searchParams.get("start")).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.searchParams.get("end")).toBe("2026-02-01T00:00:00.000Z");
    expect(init.headers).toMatchObject({ "X-Internal-Secret": expect.any(String) });

    expect(usage).toEqual({ traces: 12, spans: 120, detectorRuns: 4, bySource });
  });

  it("defaults detector_runs to 0 when the backend omits it", async () => {
    stubFetch({ traces: 1, spans: 2 });

    const usage = await getWorkspaceUsageDetails({ projectIds: ["p1"], ...WINDOW });

    expect(usage.detectorRuns).toBe(0);
  });
});
