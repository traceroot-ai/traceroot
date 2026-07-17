import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock responses don't carry NextResponse's full type — cast at call sites.
type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const dashboardFindFirstMock = vi.fn();
const dashboardUpdateMock = vi.fn();
const dashboardDeleteMock = vi.fn();
const widgetFindFirstMock = vi.fn();
const widgetCreateMock = vi.fn();
const widgetUpdateMock = vi.fn();
const widgetDeleteMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    dashboard: {
      findFirst: (...args: unknown[]) => dashboardFindFirstMock(...args),
      update: (...args: unknown[]) => dashboardUpdateMock(...args),
      delete: (...args: unknown[]) => dashboardDeleteMock(...args),
    },
    widget: {
      findFirst: (...args: unknown[]) => widgetFindFirstMock(...args),
      create: (...args: unknown[]) => widgetCreateMock(...args),
      update: (...args: unknown[]) => widgetUpdateMock(...args),
      delete: (...args: unknown[]) => widgetDeleteMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { GET, PATCH, DELETE } from "./route";

function makeRequest(body?: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams(projectId = "proj-1", dashboardId = "dash-1") {
  return { params: Promise.resolve({ projectId, dashboardId }) };
}

const fakeDashboard = {
  id: "dash-1",
  projectId: "proj-1",
  name: "My Dashboard",
  description: null,
  isDefault: false,
  layout: [],
  widgets: [],
};

const fakeWidget = {
  id: "widget-1",
  dashboardId: "dash-1",
  title: "My Widget",
  type: "query",
  spec: { sql: "SELECT 1" },
  displayConfig: {},
};

beforeEach(() => {
  dashboardFindFirstMock.mockReset();
  dashboardUpdateMock.mockReset();
  dashboardDeleteMock.mockReset();
  widgetFindFirstMock.mockReset();
  widgetCreateMock.mockReset();
  widgetUpdateMock.mockReset();
  widgetDeleteMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  // Default: authenticated with project access.
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// GET /dashboards/[dashboardId]
// ---------------------------------------------------------------------------
describe("GET /dashboards/[dashboardId]", () => {
  it("returns 404 when dashboard is not found in the project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);

    const res = (await GET(makeRequest(), makeParams("proj-1", "dash-999"))) as MockResponse;
    expect(res.status).toBe(404);

    // The where clause must scope by BOTH id AND projectId
    const [call] = dashboardFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("dash-999");
    expect(where.projectId).toBe("proj-1");
  });

  it("returns 200 with dashboard including widgets ordered by createTime", async () => {
    const dashboardWithWidgets = { ...fakeDashboard, widgets: [fakeWidget] };
    dashboardFindFirstMock.mockResolvedValue(dashboardWithWidgets);

    const res = (await GET(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: typeof dashboardWithWidgets };
    expect(body.dashboard).toEqual(dashboardWithWidgets);
    expect(body.dashboard.widgets).toHaveLength(1);

    // Verify include clause includes widgets ordered by createTime asc
    const [call] = dashboardFindFirstMock.mock.calls;
    const include = (call[0] as { include?: Record<string, unknown> }).include;
    expect(include?.widgets).toMatchObject({ orderBy: { createTime: "asc" } });
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await GET(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(401);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = (await GET(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /dashboards/[dashboardId]
// ---------------------------------------------------------------------------
describe("PATCH /dashboards/[dashboardId]", () => {
  it("updates layout and returns 200", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const updatedLayout = [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }];
    dashboardUpdateMock.mockResolvedValue({ ...fakeDashboard, layout: updatedLayout });

    const res = (await PATCH(makeRequest({ layout: updatedLayout }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: Record<string, unknown> };
    expect(body.dashboard.layout).toEqual(updatedLayout);

    const [call] = dashboardUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.layout).toEqual(updatedLayout);
    // isDefault must never be settable via PATCH
    expect(data.isDefault).toBeUndefined();
  });

  it("returns 400 for empty body (no fields to update)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({}), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-object body (array)", async () => {
    const req = { json: async () => ["a", "b"] } as unknown as Parameters<typeof PATCH>[0];
    const res = (await PATCH(req, makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-object body (null)", async () => {
    const req = { json: async () => null } as unknown as Parameters<typeof PATCH>[0];
    const res = (await PATCH(req, makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });

  it("does not accept isDefault from request body", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    dashboardUpdateMock.mockResolvedValue({ ...fakeDashboard, name: "Renamed" });

    await PATCH(makeRequest({ name: "Renamed", isDefault: true }), makeParams());

    const [call] = dashboardUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.isDefault).toBeUndefined();
    expect(data.name).toBe("Renamed");
  });

  it("returns 400 for non-string name", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({ name: 42 }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for empty name", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({ name: "  " }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-array layout", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({ layout: { i: "w1" } }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 404 when dashboard not found in project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);
    const res = (await PATCH(
      makeRequest({ name: "New" }),
      makeParams("proj-1", "dash-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();

    const [call] = dashboardFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("dash-999");
    expect(where.projectId).toBe("proj-1");
  });
});

// ---------------------------------------------------------------------------
// DELETE /dashboards/[dashboardId]
// ---------------------------------------------------------------------------
describe("DELETE /dashboards/[dashboardId]", () => {
  it("returns 200 with deleted: true after scoped findFirst", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    dashboardDeleteMock.mockResolvedValue({});

    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    // Ensure the findFirst used both id and projectId
    const [call] = dashboardFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("dash-1");
    expect(where.projectId).toBe("proj-1");
  });

  it("returns 404 when dashboard not found in project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);
    const res = (await DELETE(makeRequest(), makeParams("proj-1", "dash-999"))) as MockResponse;
    expect(res.status).toBe(404);
    expect(dashboardDeleteMock).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(401);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default dashboard is read-only
// ---------------------------------------------------------------------------
describe("default dashboard is read-only", () => {
  const defaultDashboard = { ...fakeDashboard, isDefault: true };

  it("PATCH /dashboards/[dashboardId] returns 403", async () => {
    dashboardFindFirstMock.mockResolvedValue(defaultDashboard);
    const res = (await PATCH(makeRequest({ name: "renamed" }), makeParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("DELETE /dashboards/[dashboardId] returns 403", async () => {
    dashboardFindFirstMock.mockResolvedValue(defaultDashboard);
    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(dashboardDeleteMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /dashboards/[dashboardId] — name length cap", () => {
  it("rejects a rename longer than 100 characters", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({ name: "x".repeat(101) }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });
});
