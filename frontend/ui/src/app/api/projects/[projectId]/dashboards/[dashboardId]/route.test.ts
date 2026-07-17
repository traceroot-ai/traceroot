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
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
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
import { POST as widgetPOST } from "./widgets/route";
import { PATCH as widgetPATCH, DELETE as widgetDELETE } from "./widgets/[widgetId]/route";

function makeRequest(body?: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams(projectId = "proj-1", dashboardId = "dash-1") {
  return { params: Promise.resolve({ projectId, dashboardId }) };
}

function makeWidgetParams(projectId = "proj-1", dashboardId = "dash-1", widgetId = "widget-1") {
  return { params: Promise.resolve({ projectId, dashboardId, widgetId }) };
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
// POST /dashboards/[dashboardId]/widgets
// ---------------------------------------------------------------------------
describe("POST /dashboards/[dashboardId]/widgets", () => {
  it("creates a widget and returns 201", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    const res = (await widgetPOST(
      makeRequest({ title: "My Widget", type: "query", spec: { sql: "SELECT 1" } }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { widget: typeof fakeWidget };
    expect(body.widget).toEqual(fakeWidget);
    expect(widgetCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an invalid widget type", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await widgetPOST(
      makeRequest({ title: "My Widget", type: "bad_type", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 404 when dashboard is not in the project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);
    const res = (await widgetPOST(
      makeRequest({ title: "My Widget", type: "query", spec: {} }),
      makeParams("proj-1", "dash-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetCreateMock).not.toHaveBeenCalled();

    // Assert the dashboard findFirst includes projectId scoping
    const [call] = dashboardFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("dash-999");
    expect(where.projectId).toBe("proj-1");
  });

  it("returns 400 for missing title", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await widgetPOST(
      makeRequest({ type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-object spec", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await widgetPOST(
      makeRequest({ title: "W", type: "query", spec: "bad" }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid displayConfig (array)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await widgetPOST(
      makeRequest({ title: "W", type: "query", spec: {}, displayConfig: [1, 2] }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /dashboards/[dashboardId]/widgets/[widgetId]
// ---------------------------------------------------------------------------
describe("PATCH /dashboards/[dashboardId]/widgets/[widgetId]", () => {
  it("returns 404 when widget is not in the dashboard/project scope", async () => {
    widgetFindFirstMock.mockResolvedValue(null);

    const res = (await widgetPATCH(
      makeRequest({ title: "New Title" }),
      makeWidgetParams("proj-1", "dash-1", "widget-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetUpdateMock).not.toHaveBeenCalled();

    // Assert the nested projectId scoping in the where clause
    const [call] = widgetFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("widget-999");
    expect(where.dashboardId).toBe("dash-1");
    expect((where.dashboard as Record<string, unknown>).projectId).toBe("proj-1");
  });

  it("updates title and returns 200", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, title: "Updated" });

    const res = (await widgetPATCH(
      makeRequest({ title: "Updated" }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widget: Record<string, unknown> };
    expect(body.widget.title).toBe("Updated");
  });

  it("returns 400 for empty body (no fields to update)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await widgetPATCH(makeRequest({}), makeWidgetParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for non-object spec", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await widgetPATCH(
      makeRequest({ spec: "bad" }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for empty title string", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await widgetPATCH(
      makeRequest({ title: "  " }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /dashboards/[dashboardId]/widgets/[widgetId]
// ---------------------------------------------------------------------------
describe("DELETE /dashboards/[dashboardId]/widgets/[widgetId]", () => {
  it("returns 200 with deleted: true", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetDeleteMock.mockResolvedValue({});

    const res = (await widgetDELETE(makeRequest(), makeWidgetParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    // Check scoped findFirst
    const [call] = widgetFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("widget-1");
    expect(where.dashboardId).toBe("dash-1");
    expect((where.dashboard as Record<string, unknown>).projectId).toBe("proj-1");
  });

  it("returns 404 when widget not found in scope", async () => {
    widgetFindFirstMock.mockResolvedValue(null);
    const res = (await widgetDELETE(
      makeRequest(),
      makeWidgetParams("proj-1", "dash-1", "w-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetDeleteMock).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await widgetDELETE(makeRequest(), makeWidgetParams())) as MockResponse;
    expect(res.status).toBe(401);
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
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

  it("POST .../widgets returns 403", async () => {
    dashboardFindFirstMock.mockResolvedValue(defaultDashboard);
    const res = (await widgetPOST(
      makeRequest({ title: "t", type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(403);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("PATCH .../widgets/[widgetId] returns 403", async () => {
    widgetFindFirstMock.mockResolvedValue({ ...fakeWidget, dashboard: { isDefault: true } });
    const res = (await widgetPATCH(
      makeRequest({ title: "renamed" }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(res.status).toBe(403);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("DELETE .../widgets/[widgetId] returns 403", async () => {
    widgetFindFirstMock.mockResolvedValue({ ...fakeWidget, dashboard: { isDefault: true } });
    const res = (await widgetDELETE(makeRequest(), makeWidgetParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(widgetDeleteMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /dashboards/[dashboardId] — name length cap", () => {
  it("rejects a rename longer than 50 characters but allows exactly 50", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(makeRequest({ name: "x".repeat(51) }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();

    dashboardUpdateMock.mockResolvedValue({ ...fakeDashboard, name: "x".repeat(50) });
    const ok = (await PATCH(makeRequest({ name: "x".repeat(50) }), makeParams())) as MockResponse;
    expect(ok.status).toBe(200);
    expect(dashboardUpdateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Hardening: role gate, layout entry validation, description cap, races
// ---------------------------------------------------------------------------
describe("mutation hardening", () => {
  it("gates mutations on MEMBER role but leaves GET viewer-accessible", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    dashboardUpdateMock.mockResolvedValue(fakeDashboard);

    await GET(makeRequest(), makeParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", undefined);

    await PATCH(makeRequest({ name: "renamed" }), makeParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", "MEMBER");

    await DELETE(makeRequest(), makeParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", "MEMBER");

    await widgetPOST(makeRequest({ title: "t", type: "query", spec: {} }), makeParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", "MEMBER");

    await widgetPATCH(makeRequest({ title: "t" }), makeWidgetParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", "MEMBER");

    await widgetDELETE(makeRequest(), makeWidgetParams());
    expect(requireProjectAccessMock).toHaveBeenLastCalledWith("user-1", "proj-1", "MEMBER");
  });

  it("rejects layout entries that are not {i, x, y, w, h} placements", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    for (const bad of [
      [null],
      ["x"],
      [{ i: "w1", x: "a", y: 0, w: 4, h: 4 }],
      [{ x: 0, y: 0, w: 4, h: 4 }],
      [{ i: "w1", x: 0, y: 0, w: 4, h: Infinity }],
    ]) {
      const res = (await PATCH(makeRequest({ layout: bad }), makeParams())) as MockResponse;
      expect(res.status).toBe(400);
    }
    expect(dashboardUpdateMock).not.toHaveBeenCalled();

    const ok = (await PATCH(
      makeRequest({ layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }] }),
      makeParams(),
    )) as MockResponse;
    expect(ok.status).toBe(200);
  });

  it("rejects negative coordinates and strips unknown keys from layout entries", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);

    const negative = (await PATCH(
      makeRequest({ layout: [{ i: "w1", x: -1, y: 0, w: 4, h: 4 }] }),
      makeParams(),
    )) as MockResponse;
    expect(negative.status).toBe(400);

    dashboardUpdateMock.mockResolvedValue(fakeDashboard);
    await PATCH(
      makeRequest({
        // static/isDraggable would be honored by react-grid-layout for every
        // member if persisted; only the placement keys may reach storage.
        layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4, static: true, isDraggable: false }],
      }),
      makeParams(),
    );
    const [call] = dashboardUpdateMock.mock.calls;
    expect((call[0] as { data: { layout: unknown } }).data.layout).toEqual([
      { i: "w1", x: 0, y: 0, w: 4, h: 4 },
    ]);
  });

  it("caps the dashboard description at 500 characters", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await PATCH(
      makeRequest({ description: "x".repeat(501) }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
  });

  it("caps the widget title at 100 characters on POST and PATCH", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const post = (await widgetPOST(
      makeRequest({ title: "x".repeat(101), type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(post.status).toBe(400);

    widgetFindFirstMock.mockResolvedValue({ ...fakeWidget, dashboard: { isDefault: false } });
    const patch = (await widgetPATCH(
      makeRequest({ title: "x".repeat(101) }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(patch.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("maps a concurrent delete (Prisma P2025) to 404 instead of 500", async () => {
    const { Prisma } = await import("@prisma/client");
    const gone = new Prisma.PrismaClientKnownRequestError("gone", {
      code: "P2025",
      clientVersion: "test",
    });

    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    dashboardUpdateMock.mockRejectedValue(gone);
    const patch = (await PATCH(makeRequest({ name: "renamed" }), makeParams())) as MockResponse;
    expect(patch.status).toBe(404);

    dashboardDeleteMock.mockRejectedValue(gone);
    const del = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(del.status).toBe(404);

    widgetFindFirstMock.mockResolvedValue({ ...fakeWidget, dashboard: { isDefault: false } });
    widgetUpdateMock.mockRejectedValue(gone);
    const wpatch = (await widgetPATCH(
      makeRequest({ title: "renamed" }),
      makeWidgetParams(),
    )) as MockResponse;
    expect(wpatch.status).toBe(404);

    widgetDeleteMock.mockRejectedValue(gone);
    const wdel = (await widgetDELETE(makeRequest(), makeWidgetParams())) as MockResponse;
    expect(wdel.status).toBe(404);
  });
});
