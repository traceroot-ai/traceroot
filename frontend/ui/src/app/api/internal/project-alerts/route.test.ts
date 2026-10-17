import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const alertFindManyMock = vi.fn();
const alertFindFirstMock = vi.fn();
const alertCountMock = vi.fn();
const userFindManyMock = vi.fn();
// The route reaches the shared alerts schema module, which reads the alert
// vocabulary from core, so only the prisma client is replaced.
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    // The list runs its page and count in one transaction; the mock resolves
    // the already-issued promises in order.
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    alert: {
      findMany: (...args: unknown[]) => alertFindManyMock(...args),
      findFirst: (...args: unknown[]) => alertFindFirstMock(...args),
      count: (...args: unknown[]) => alertCountMock(...args),
    },
    user: {
      findMany: (...args: unknown[]) => userFindManyMock(...args),
    },
  },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const CREATE_TIME = new Date("2026-08-01T00:00:00Z");
const UPDATE_TIME = new Date("2026-08-02T00:00:00Z");

const summaryRow = {
  id: "alert-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  thresholdOperator: ">",
  threshold: { toNumber: () => 500 },
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: UPDATE_TIME,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: CREATE_TIME,
  updateTime: UPDATE_TIME,
  createdBy: "user-1",
};

const summaryExpected = {
  id: "alert-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: UPDATE_TIME,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: CREATE_TIME,
  updateTime: UPDATE_TIME,
  creator: "Ada Lovelace",
};

beforeEach(() => {
  alertFindManyMock.mockReset();
  alertFindFirstMock.mockReset();
  alertCountMock.mockReset();
  userFindManyMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  userFindManyMock.mockResolvedValue([
    { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
  ]);
});

describe("POST /api/internal/project-alerts", () => {
  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(alertFindManyMock).not.toHaveBeenCalled();
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with a 400", async () => {
    const req = {
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("rejects a missing projectId with a 400", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required" });
    expect(alertFindManyMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string alertId with a 400", async () => {
    const res = await POST(makeRequest({ projectId: "proj-1", alertId: 7 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "alertId must be a string" });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
  });

  it("lists the project's alerts with resolved creators and the capacity meta", async () => {
    alertFindManyMock.mockResolvedValue([
      summaryRow,
      { ...summaryRow, id: "alert-2", name: "Errors", createdBy: "user-gone" },
    ]);
    alertCountMock.mockResolvedValue(2);

    const res = await POST(makeRequest({ projectId: "proj-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      alerts: [
        summaryExpected,
        // user-gone is deleted: it resolves to no row, so the creator is null.
        { ...summaryExpected, id: "alert-2", name: "Errors", creator: null },
      ],
      meta: { page: 0, limit: 50, total: 2, capacity: { used: 2, max: 100 } },
    });
    expect(alertFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { projectId: "proj-1" },
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
      skip: 0,
      take: 50,
    });
    // Without a search the page count doubles as the capacity count.
    expect(alertCountMock).toHaveBeenCalledTimes(1);
  });

  it("pages, clamps the limit, and counts the whole project when searching", async () => {
    alertFindManyMock.mockResolvedValue([summaryRow]);
    alertCountMock.mockResolvedValueOnce(1).mockResolvedValueOnce(7);

    const res = await POST(
      makeRequest({ projectId: "proj-1", limit: 999, page: 2, searchQuery: "  lat " }),
    );
    const body = (await res.json()) as { meta: unknown };

    expect(res.status).toBe(200);
    expect(body.meta).toEqual({
      page: 2,
      limit: 200,
      total: 1,
      capacity: { used: 7, max: 100 },
    });
    expect(alertFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { projectId: "proj-1", name: { contains: "lat", mode: "insensitive" } },
      skip: 400,
      take: 200,
    });
    expect(alertCountMock.mock.calls[1][0]).toEqual({ where: { projectId: "proj-1" } });
  });

  it("returns an empty list without a creator lookup when the project has no alerts", async () => {
    alertFindManyMock.mockResolvedValue([]);
    alertCountMock.mockResolvedValue(0);

    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      alerts: [],
      meta: { page: 0, limit: 50, total: 0, capacity: { used: 0, max: 100 } },
    });
    expect(userFindManyMock).not.toHaveBeenCalled();
  });

  it("fetches one alert with its rule fields, scoped through the project", async () => {
    alertFindFirstMock.mockResolvedValue({
      ...summaryRow,
      filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
      renotify: { mode: "EVERY", intervalMinutes: 60 },
      noDataMode: "HOLD",
    });

    const res = await POST(makeRequest({ projectId: "proj-1", alertId: "alert-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      alert: {
        ...summaryExpected,
        filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
        renotify: { mode: "EVERY", intervalMinutes: 60 },
        noDataMode: "HOLD",
      },
    });
    expect(alertFindFirstMock.mock.calls[0][0]).toMatchObject({
      where: { id: "alert-1", projectId: "proj-1" },
    });
    expect(alertFindManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the alert is not in the project", async () => {
    alertFindFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ projectId: "proj-1", alertId: "other-projects-alert" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Alert not found" });
  });
});
