import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock responses don't carry NextResponse's full type — cast at call sites.
type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const widgetFindFirstMock = vi.fn();
const widgetUpdateMock = vi.fn();
const widgetDeleteMock = vi.fn();
const dashboardUpdateMock = vi.fn();
const auditCreateMock = vi.fn();

// The handlers delegate to the write service, which runs its own tenancy
// check and audit inside a transaction on this same client.
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  const client = {
    project: { findUnique: async () => ({ workspaceId: "ws-1", deleteTime: null }) },
    workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
    widget: {
      findFirst: (...args: unknown[]) => widgetFindFirstMock(...args),
      update: (...args: unknown[]) => widgetUpdateMock(...args),
      delete: (...args: unknown[]) => widgetDeleteMock(...args),
    },
    dashboard: { update: (...args: unknown[]) => dashboardUpdateMock(...args) },
    auditLog: { create: (...args: unknown[]) => auditCreateMock(...args) },
    $queryRaw: async () => [{ layout: [{ i: "widget-1", x: 0, y: 0, w: 6, h: 4 }] }],
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return {
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
    prisma: client,
  };
});

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

import { PATCH, DELETE } from "./route";

function makeRequest(body?: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof PATCH>[0];
}

function makeInvalidJsonRequest() {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams(projectId = "proj-1", dashboardId = "dash-1", widgetId = "widget-1") {
  return { params: Promise.resolve({ projectId, dashboardId, widgetId }) };
}

// A stored spec in the canonical query dialect, as the write service stores it.
const storedSpec = {
  view: "spans",
  filters: [],
  metric: { measure: "count", agg: "count" },
  breakdown: null,
  display: { type: "number" },
};

const fakeWidget = {
  id: "widget-1",
  dashboardId: "dash-1",
  title: "My Widget",
  type: "query",
  spec: storedSpec,
  displayConfig: {},
};

beforeEach(() => {
  widgetFindFirstMock.mockReset();
  widgetUpdateMock.mockReset();
  widgetDeleteMock.mockReset();
  dashboardUpdateMock.mockReset();
  auditCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  // Default: authenticated with project access.
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// PATCH /dashboards/[dashboardId]/widgets/[widgetId]
// ---------------------------------------------------------------------------
describe("PATCH /dashboards/[dashboardId]/widgets/[widgetId]", () => {
  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await PATCH(makeRequest({ title: "New" }), makeParams())) as MockResponse;
    expect(res.status).toBe(401);
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = (await PATCH(makeRequest({ title: "New" }), makeParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the widget is not in the dashboard/project scope", async () => {
    widgetFindFirstMock.mockResolvedValue(null);

    const res = (await PATCH(
      makeRequest({ title: "New Title" }),
      makeParams("proj-1", "dash-1", "widget-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetUpdateMock).not.toHaveBeenCalled();

    // The lookup must scope by widget id, dashboardId AND the nested projectId.
    const [call] = widgetFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("widget-999");
    expect(where.dashboardId).toBe("dash-1");
    expect((where.dashboard as Record<string, unknown>).projectId).toBe("proj-1");
  });

  it("returns 400 for invalid JSON body", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeInvalidJsonRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object body (array)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest(["a"]), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object body (null)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest(null), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for empty body (no fields to update)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({}), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-string title", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ title: 42 }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty (whitespace-only) title", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ title: "   " }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object spec", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ spec: "bad" }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a null spec", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ spec: null }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid displayConfig (array)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ displayConfig: [1, 2] }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("resets displayConfig to {} on null", async () => {
    widgetFindFirstMock.mockResolvedValue({ ...fakeWidget, displayConfig: { type: "bar" } });
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, displayConfig: {} });
    const res = (await PATCH(makeRequest({ displayConfig: null }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const [call] = widgetUpdateMock.mock.calls;
    expect((call[0] as { data: Record<string, unknown> }).data).toEqual({ displayConfig: {} });
  });

  it("validates the spec against the stored type, refusing a foreign dialect", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(
      makeRequest({ spec: { filters: [{ field: "errors", op: "gt", value: 0 }] } }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^spec is not a valid widget spec: /,
    );
    expect(widgetUpdateMock).not.toHaveBeenCalled();
  });

  it("answers a patch that changes nothing with 200 and no write", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ title: "My Widget" }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { widget: { title: string } }).widget.title).toBe("My Widget");
    expect(widgetUpdateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("updates title only and returns 200", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, title: "Updated" });

    const res = (await PATCH(makeRequest({ title: "  Updated  " }), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widget: Record<string, unknown> };
    expect(body.widget.title).toBe("Updated");

    const [call] = widgetUpdateMock.mock.calls;
    expect((call[0] as { where: { id: string } }).where.id).toBe("widget-1");
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ title: "Updated" });
  });

  it("updates spec only, storing the parsed shape and leaving other fields untouched", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const newSpec = { ...storedSpec, view: "traces" };
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, spec: newSpec });

    await PATCH(makeRequest({ spec: { ...newSpec, extraneous: "x" } }), makeParams());

    const [call] = widgetUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ spec: newSpec });
  });

  it("updates displayConfig only", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const newDisplayConfig = { type: "bar" };
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, displayConfig: newDisplayConfig });

    await PATCH(makeRequest({ displayConfig: newDisplayConfig }), makeParams());

    const [call] = widgetUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ displayConfig: newDisplayConfig });
  });

  it("updates multiple fields together", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, title: "Both" });

    const newSpec = { ...storedSpec, view: "traces" };
    await PATCH(
      makeRequest({ title: "Both", spec: newSpec, displayConfig: { type: "line" } }),
      makeParams(),
    );

    const [call] = widgetUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      title: "Both",
      spec: newSpec,
      displayConfig: { type: "line" },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /dashboards/[dashboardId]/widgets/[widgetId]
// ---------------------------------------------------------------------------
describe("DELETE /dashboards/[dashboardId]/widgets/[widgetId]", () => {
  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(401);
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(403);
    expect(widgetFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the widget is not found in the dashboard/project scope", async () => {
    widgetFindFirstMock.mockResolvedValue(null);
    const res = (await DELETE(
      makeRequest(),
      makeParams("proj-1", "dash-1", "widget-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetDeleteMock).not.toHaveBeenCalled();

    const [call] = widgetFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("widget-999");
    expect(where.dashboardId).toBe("dash-1");
    expect((where.dashboard as Record<string, unknown>).projectId).toBe("proj-1");
  });

  it("deletes the widget and returns 200 with deleted: true", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetDeleteMock.mockResolvedValue({});

    const res = (await DELETE(makeRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    expect(widgetDeleteMock).toHaveBeenCalledWith({ where: { id: "widget-1" } });
    // The widget's placement goes with it, so the grid never carries a tile
    // that no longer exists.
    expect(dashboardUpdateMock).toHaveBeenCalledWith({
      where: { id: "dash-1" },
      data: { layout: [] },
    });
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_widget",
        transport: "ui",
        summary: { name: "My Widget", reason: "Deleted from the web app" },
      }),
    });
  });

  it("records the reason the web app sends when it sends one", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    widgetDeleteMock.mockResolvedValue({});
    await DELETE(makeRequest({ reason: "no longer needed" }), makeParams());
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summary: { name: "My Widget", reason: "no longer needed" },
      }),
    });
  });
});
