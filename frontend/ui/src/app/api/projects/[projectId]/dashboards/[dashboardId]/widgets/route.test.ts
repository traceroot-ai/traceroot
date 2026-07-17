import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock responses don't carry NextResponse's full type — cast at call sites.
type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const dashboardFindFirstMock = vi.fn();
const widgetCreateMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    dashboard: {
      findFirst: (...args: unknown[]) => dashboardFindFirstMock(...args),
    },
    widget: {
      create: (...args: unknown[]) => widgetCreateMock(...args),
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

import { POST } from "./route";

function makeRequest(body?: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function makeInvalidJsonRequest() {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  } as unknown as Parameters<typeof POST>[0];
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
};

const fakeWidget = {
  id: "widget-1",
  dashboardId: "dash-1",
  title: "My Widget",
  type: "query",
  spec: { view: "spans" },
  displayConfig: {},
};

beforeEach(() => {
  dashboardFindFirstMock.mockReset();
  widgetCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  // Default: authenticated with project access.
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
});

describe("POST /dashboards/[dashboardId]/widgets", () => {
  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(401);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(403);
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the dashboard does not belong to the project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);

    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: {} }),
      makeParams("proj-1", "dash-999"),
    )) as MockResponse;
    expect(res.status).toBe(404);
    expect(widgetCreateMock).not.toHaveBeenCalled();

    // Scoped by both dashboard id AND projectId.
    const [call] = dashboardFindFirstMock.mock.calls;
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.id).toBe("dash-999");
    expect(where.projectId).toBe("proj-1");
  });

  it("returns 400 for invalid JSON body", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(makeInvalidJsonRequest(), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object body (array)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(makeRequest(["a", "b"]), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object body (null)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(makeRequest(null), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for missing title", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/title/i);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty (whitespace-only) title", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "   ", type: "query", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing type", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(makeRequest({ title: "W", spec: {} }), makeParams())) as MockResponse;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/type/i);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid widget type", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "bad_type", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object spec (string)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: "bad" }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object spec (array)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: [1, 2] }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a null spec", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: null }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid displayConfig (array)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: {}, displayConfig: [1, 2] }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid displayConfig (string)", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec: {}, displayConfig: "bad" }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("creates a widget scoped to the dashboard and returns 201", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    const res = (await POST(
      makeRequest({
        title: "  My Widget  ",
        type: "query",
        spec: { view: "spans" },
      }),
      makeParams("proj-1", "dash-1"),
    )) as MockResponse;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { widget: typeof fakeWidget };
    expect(body.widget).toEqual(fakeWidget);

    expect(widgetCreateMock).toHaveBeenCalledTimes(1);
    const [call] = widgetCreateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.dashboardId).toBe("dash-1");
    // Title is trimmed before persisting.
    expect(data.title).toBe("My Widget");
    expect(data.type).toBe("query");
    expect(data.spec).toEqual({ view: "spans" });
    // displayConfig defaults to {} when omitted.
    expect(data.displayConfig).toEqual({});
  });

  it("persists a provided displayConfig as-is", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    await POST(
      makeRequest({
        title: "W",
        type: "trace_feed",
        spec: {},
        displayConfig: { type: "table" },
      }),
      makeParams(),
    );

    const [call] = widgetCreateMock.mock.calls;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.displayConfig).toEqual({ type: "table" });
  });
});
