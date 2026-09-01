import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock responses don't carry NextResponse's full type — cast at call sites.
type MockResponse = { status: number; json: () => Promise<unknown> };

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const dashboardFindFirstMock = vi.fn();
const dashboardUpdateMock = vi.fn();
const widgetCreateMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();
// Any write that reaches the root client instead of the transaction.
const outsideTransactionMock = vi.fn();

vi.mock("@traceroot/core", () => {
  // The transaction client is a DIFFERENT object from `prisma`, and only it
  // carries the write spies. A write issued outside the transaction lands on
  // outsideTransactionMock instead, so dropping the $transaction wrapper
  // fails this suite rather than silently releasing the row lock at
  // autocommit — which is the whole point of taking the lock.
  const tx = {
    dashboard: { update: (...args: unknown[]) => dashboardUpdateMock(...args) },
    widget: { create: (...args: unknown[]) => widgetCreateMock(...args) },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  };
  const client = {
    dashboard: {
      findFirst: (...args: unknown[]) => dashboardFindFirstMock(...args),
      update: (...args: unknown[]) => outsideTransactionMock("dashboard.update", ...args),
    },
    widget: {
      create: (...args: unknown[]) => outsideTransactionMock("widget.create", ...args),
    },
    $queryRaw: (...args: unknown[]) => outsideTransactionMock("$queryRaw", ...args),
    $transaction: (fn: (tx: unknown) => unknown) => {
      transactionMock();
      return fn(tx);
    },
  };
  return { Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" }, prisma: client };
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

import { WIDGET_TYPES } from "@/features/dashboards/types";
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
  dashboardUpdateMock.mockReset();
  widgetCreateMock.mockReset();
  queryRawMock.mockReset();
  transactionMock.mockReset();
  outsideTransactionMock.mockReset();
  // Default: the locking read finds an empty layout.
  queryRawMock.mockResolvedValue([{ layout: [] }]);
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

  it("gives the created widget a placement in the dashboard layout", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    const res = (await POST(
      makeRequest({ title: "My Widget", type: "query", spec: { view: "spans" } }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(201);
    expect(dashboardUpdateMock).toHaveBeenCalledWith({
      where: { id: "dash-1" },
      data: { layout: [{ i: "widget-1", x: 0, y: 0, w: 6, h: 4 }] },
    });
  });

  it("packs the placement beside the tile already on the bottom row", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue({ ...fakeWidget, type: "trace_feed" });
    queryRawMock.mockResolvedValue([{ layout: [{ i: "w0", x: 0, y: 4, w: 6, h: 4 }] }]);

    await POST(makeRequest({ title: "W", type: "trace_feed", spec: {} }), makeParams());
    expect(dashboardUpdateMock).toHaveBeenCalledWith({
      where: { id: "dash-1" },
      data: {
        layout: [
          { i: "w0", x: 0, y: 4, w: 6, h: 4 },
          { i: "widget-1", x: 6, y: 4, w: 6, h: 6 },
        ],
      },
    });
  });

  it("locks the dashboard row before the widget insert and the layout read", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    await POST(makeRequest({ title: "W", type: "query", spec: {} }), makeParams());
    const [strings, ...values] = queryRawMock.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/SELECT layout FROM dashboards WHERE id = \? FOR UPDATE/);
    expect(sql).not.toContain("dash-1");
    expect(values).toEqual(["dash-1"]);
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      widgetCreateMock.mock.invocationCallOrder[0],
    );
    expect(widgetCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
      dashboardUpdateMock.mock.invocationCallOrder[0],
    );
  });

  // Same vocabulary gate as the API/agent write path: a spec naming fields the
  // registry doesn't know stores fine and then fails at query time forever.
  it("rejects a query spec the field registry doesn't know, listing the valid options", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({
        title: "W",
        type: "query",
        spec: {
          view: "spans",
          filters: [],
          metric: { measure: "spans", agg: "count" },
          breakdown: null,
          display: { type: "number" },
        },
      }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^unknown measure "spans" for view "spans" — valid measures: /);
    expect(widgetCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("stores a builder-shaped query spec the registry knows", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);
    const spec = {
      view: "spans",
      filters: [{ field: "span_kind", op: "=", value: "LLM" }],
      metric: { measure: "duration_ms", agg: "p95" },
      breakdown: "model_name",
      display: { type: "bar" },
    };
    const res = (await POST(
      makeRequest({ title: "W", type: "query", spec }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(201);
    // Stored as sent — the route validates the vocabulary without rewriting.
    const data = (widgetCreateMock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.spec).toEqual(spec);
  });

  it("leaves trace_feed specs to their own validation", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);
    const res = (await POST(
      makeRequest({ title: "W", type: "trace_feed", spec: { metric: { measure: "spans" } } }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(201);
  });

  it("runs the lock, the insert and the layout write in one transaction", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    widgetCreateMock.mockResolvedValue(fakeWidget);

    await POST(makeRequest({ title: "W", type: "query", spec: {} }), makeParams());
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // Every write went through the transaction client, none to the root one:
    // a lock taken outside the transaction is released at autocommit and
    // serializes nothing.
    expect(outsideTransactionMock).not.toHaveBeenCalled();
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(widgetCreateMock).toHaveBeenCalledTimes(1);
    expect(dashboardUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a type outside the shared widget-type list, naming the allowed ones", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "detector", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(`type must be one of ${WIDGET_TYPES.join(", ")}`);
    expect(widgetCreateMock).not.toHaveBeenCalled();
  });

  it("neither locks nor rewrites the layout when the body is rejected", async () => {
    dashboardFindFirstMock.mockResolvedValue(fakeDashboard);
    const res = (await POST(
      makeRequest({ title: "W", type: "bad_type", spec: {} }),
      makeParams(),
    )) as MockResponse;
    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(dashboardUpdateMock).not.toHaveBeenCalled();
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
