import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock responses don't carry NextResponse's full type — cast at call sites.
type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const widgetFindFirstMock = vi.fn();
const widgetUpdateMock = vi.fn();
const widgetDeleteMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    widget: {
      findFirst: (...args: unknown[]) => widgetFindFirstMock(...args),
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

const fakeWidget = {
  id: "widget-1",
  dashboardId: "dash-1",
  title: "My Widget",
  type: "query",
  spec: { view: "spans" },
  displayConfig: {},
};

beforeEach(() => {
  widgetFindFirstMock.mockReset();
  widgetUpdateMock.mockReset();
  widgetDeleteMock.mockReset();
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

  it("returns 400 for an invalid displayConfig (null)", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const res = (await PATCH(makeRequest({ displayConfig: null }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetUpdateMock).not.toHaveBeenCalled();
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

  it("updates spec only, leaving other fields untouched in the update payload", async () => {
    widgetFindFirstMock.mockResolvedValue(fakeWidget);
    const newSpec = { view: "traces" };
    widgetUpdateMock.mockResolvedValue({ ...fakeWidget, spec: newSpec });

    await PATCH(makeRequest({ spec: newSpec }), makeParams());

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

    await PATCH(
      makeRequest({ title: "Both", spec: { view: "spans" }, displayConfig: { type: "line" } }),
      makeParams(),
    );

    const [call] = widgetUpdateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      title: "Both",
      spec: { view: "spans" },
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
  });
});
