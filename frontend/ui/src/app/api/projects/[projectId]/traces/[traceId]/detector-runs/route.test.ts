import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const findManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
}));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "secret" } }));

import { GET } from "./route";

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", traceId: "trace-1" }) };
}

beforeEach(() => {
  findManyMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  // One existing detector (det-a) and one deleted (det-gone, absent here).
  findManyMock.mockResolvedValue([{ id: "det-a", name: "Latency detector" }]);

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      runs: [
        {
          run_id: "run-1",
          detector_id: "det-a",
          project_id: "proj-1",
          trace_id: "trace-1",
          finding_id: "find-1",
          status: "triggered",
          timestamp: "2026-06-24T00:00:00Z",
          summary: "found",
        },
        {
          run_id: "run-2",
          detector_id: "det-gone",
          project_id: "proj-1",
          trace_id: "trace-1",
          finding_id: null,
          status: "clean",
          timestamp: "2026-06-24T00:00:01Z",
          summary: "",
        },
      ],
    }),
  }) as unknown as typeof fetch;
});

describe("GET .../detector-runs — name enrichment", () => {
  it("looks up detector names once for the trace's detector_ids", async () => {
    await GET({} as never, makeParams());

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where.id.in).toEqual(["det-a", "det-gone"]);
    // Scoped to the project (defense-in-depth against cross-tenant id collisions).
    expect(findManyMock.mock.calls[0][0].where.projectId).toBe("proj-1");
  });

  it("enriches existing detectors and falls back to the id when deleted", async () => {
    const res = await GET({} as never, makeParams());
    const data = await res.json();

    const byId = Object.fromEntries(
      data.runs.map((r: { detector_id: string }) => [r.detector_id, r]),
    );
    expect(byId["det-a"].name).toBe("Latency detector");
    expect(byId["det-gone"].name).toBe("det-gone");
  });
});

describe("GET .../detector-runs — auth, access & backend errors", () => {
  it("short-circuits on auth failure before checking project access", async () => {
    const authError = { status: 401 };
    requireAuthMock.mockResolvedValue({ error: authError });

    const res = await GET({} as never, makeParams());

    expect(res).toBe(authError);
    expect(requireProjectAccessMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns the access error and never queries when project access is denied", async () => {
    const accessError = { status: 403 };
    requireProjectAccessMock.mockResolvedValue({ error: accessError });

    const res = await GET({} as never, makeParams());

    expect(res).toBe(accessError);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("propagates the backend status when the upstream fetch is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const res = await GET({} as never, makeParams());

    expect(res.status).toBe(500);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the upstream fetch throws (backend unreachable)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const res = await GET({} as never, makeParams());

    expect(res.status).toBe(502);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
