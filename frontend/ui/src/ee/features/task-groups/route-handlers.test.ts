import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const core = vi.hoisted(() => ({
  workspace: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  readState: vi.fn(),
  requestRefresh: vi.fn(),
  keyConfigured: vi.fn(),
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
  isDemoViewer: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findUnique: core.workspace },
    taskGroupSettings: { findUnique: core.settingsFind, upsert: core.settingsUpsert },
  },
  PlanType: { FREE: "free" },
  getRetentionDays: (plan: string) => (plan === "enterprise" ? null : 15),
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));
vi.mock("@traceroot/core/signals", () => ({ signalsKeyConfigured: core.keyConfigured }));
vi.mock("@traceroot/core/task-groups", () => ({
  MIN_DIGESTS_FOR_GROUPS: 100,
  REFRESH_MIN_INTERVAL_MS: 3_600_000,
  readTaskGroupState: core.readState,
  requestTaskGroupRefresh: core.requestRefresh,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: core.requireAuth,
  requireProjectAccess: core.requireProjectAccess,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));
vi.mock("@/lib/demo-workspace", () => ({
  isDemoViewer: core.isDemoViewer,
  DEMO_VIEWER_FORBIDDEN: "Not available in the demo workspace",
}));

import {
  daysBetween,
  handleByTrace,
  handleOverview,
  handleRefresh,
  handleUpdateSettings,
} from "./route-handlers";

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  core.workspace.mockResolvedValue({ billingPlan: "enterprise" });
  core.keyConfigured.mockReturnValue(true);
  core.isDemoViewer.mockReturnValue(false);
  core.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  core.requireProjectAccess.mockResolvedValue({
    project: { id: "p1", workspaceId: "w1" },
    membership: { role: "MEMBER" },
  });
});
afterEach(() => vi.unstubAllGlobals());

const params = { params: Promise.resolve({ projectId: "p1" }) };
const req = (search = "", body?: unknown) =>
  ({
    nextUrl: { searchParams: new URLSearchParams(search) },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  }) as never;

describe("daysBetween", () => {
  it("lists the UTC days of a range, oldest first", () => {
    expect(daysBetween(new Date("2026-11-06T23:00:00Z"), new Date("2026-11-08T01:00:00Z"))).toEqual(
      ["2026-11-06", "2026-11-07", "2026-11-08"],
    );
  });
});

describe("handleOverview", () => {
  const backend = {
    fit: { fit_id: "f1", fitted_at_ms: 1_700_000_000_000 },
    sampled: 10,
    ungrouped: 2,
    digests_in_window: 120,
    groups: [
      { group_id: "g1", name: "Small", description: "", count: 2, trend: [] },
      {
        group_id: "g2",
        name: "Big",
        description: "d",
        count: 6,
        trend: [{ day: "2026-11-07", count: 6 }],
      },
    ],
  };
  beforeEach(() => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => backend });
    core.readState.mockResolvedValue({
      enabled: true,
      status: "active",
      dailyCostCapUsd: 1,
      spentTodayUsd: 0.1,
      summariesToday: 5,
    });
    core.settingsFind.mockResolvedValue(null);
  });

  it("returns the groups biggest first, with each share of the sampled traces", async () => {
    const res = await handleOverview(
      req("start_after=2026-11-01T00:00:00Z&end_before=2026-11-08T00:00:00Z"),
      params,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.groups.map((g: { name: string }) => g.name)).toEqual(["Big", "Small"]);
    expect(body.groups[0].share).toBeCloseTo(0.6);
    expect(body.sampled).toBe(10);
    expect(body.minDigests).toBe(100);
    expect(body.state.keyConfigured).toBe(true);
    expect(body.days[0]).toBe("2026-11-01");
  });

  it("asks the backend for this project only, with the internal secret", async () => {
    await handleOverview(req(), params);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/internal/task-groups/overview?");
    expect(url).toContain("project_id=p1");
    expect(init.headers["X-Internal-Secret"]).toBeDefined();
  });

  it("says when the next refresh can be asked for while one is cooling down", async () => {
    core.settingsFind.mockResolvedValue({ refreshRequestedAt: new Date(Date.now() - 600_000) });
    const body = await (await handleOverview(req(), params)).json();
    expect(new Date(body.refreshAvailableAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a malformed or oversized range", async () => {
    expect((await handleOverview(req("start_after=nope"), params)).status).toBe(400);
    expect(
      (
        await handleOverview(
          req("start_after=2020-01-01T00:00:00Z&end_before=2026-01-01T00:00:00Z"),
          params,
        )
      ).status,
    ).toBe(400);
  });

  it("is 502 when the backend is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("down"));
    expect((await handleOverview(req(), params)).status).toBe(502);
  });

  it("stops at the auth check when the user may not read the project", async () => {
    core.requireProjectAccess.mockResolvedValue({ error: Response.json({}, { status: 403 }) });
    expect((await handleOverview(req(), params)).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("handleUpdateSettings", () => {
  it("needs the member role", async () => {
    core.settingsUpsert.mockResolvedValue({ enabled: true, dailyCostCapUsd: 1 });
    await handleUpdateSettings(req("", { enabled: true }), params);
    expect(core.requireProjectAccess).toHaveBeenCalledWith("u1", "p1", "MEMBER");
  });

  it("turns it on, creating the settings row the first time", async () => {
    core.settingsUpsert.mockResolvedValue({ enabled: true, dailyCostCapUsd: 1 });
    const res = await handleUpdateSettings(req("", { enabled: true }), params);
    expect(res.status).toBe(200);
    expect(core.settingsUpsert.mock.calls[0][0].create).toMatchObject({
      projectId: "p1",
      enabled: true,
    });
    expect(core.settingsUpsert.mock.calls[0][0].update).toMatchObject({ enabled: true });
  });

  it.each([{}, { dailyCostCapUsd: 0 }, { dailyCostCapUsd: 5000 }, { enabled: "yes" }])(
    "refuses %j",
    async (body) => {
      expect((await handleUpdateSettings(req("", body), params)).status).toBe(400);
      expect(core.settingsUpsert).not.toHaveBeenCalled();
    },
  );

  it("refuses a demo viewer", async () => {
    core.isDemoViewer.mockReturnValue(true);
    expect((await handleUpdateSettings(req("", { enabled: true }), params)).status).toBe(403);
  });
});

describe("handleRefresh", () => {
  it("accepts a request", async () => {
    core.requestRefresh.mockResolvedValue({ accepted: true, nextAllowedAt: null });
    expect((await handleRefresh(req(), params)).status).toBe(202);
  });

  it("answers 429 with the time the next one is taken", async () => {
    const at = new Date("2026-11-08T12:00:00Z");
    core.requestRefresh.mockResolvedValue({ accepted: false, nextAllowedAt: at });
    const res = await handleRefresh(req(), params);
    expect(res.status).toBe(429);
    expect((await res.json()).nextAllowedAt).toBe(at.toISOString());
  });

  it("answers 409 when the feature is off", async () => {
    core.requestRefresh.mockResolvedValue({ accepted: false, nextAllowedAt: null });
    expect((await handleRefresh(req(), params)).status).toBe(409);
  });
});

describe("handleByTrace", () => {
  it("maps each trace to its group", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { t1: { group_id: "g1", name: "Flights" } } }),
    });
    const body = await (await handleByTrace(req("trace_id=t1&trace_id=t2"), params)).json();
    expect(body.groups).toEqual({ t1: { groupId: "g1", name: "Flights" } });
    expect(mockFetch.mock.calls[0][0]).toContain("project_id=p1");
  });

  it("refuses more ids than one page holds, and skips the call for none", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `trace_id=t${i}`).join("&");
    expect((await handleByTrace(req(many), params)).status).toBe(400);
    expect((await (await handleByTrace(req(""), params)).json()).groups).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
