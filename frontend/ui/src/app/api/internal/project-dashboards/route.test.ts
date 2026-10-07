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

const dashboardFindManyMock = vi.fn();
const userFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    dashboard: {
      findMany: (...args: unknown[]) => dashboardFindManyMock(...args),
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

beforeEach(() => {
  dashboardFindManyMock.mockReset();
  userFindManyMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/project-dashboards", () => {
  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(dashboardFindManyMock).not.toHaveBeenCalled();
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
    expect(dashboardFindManyMock).not.toHaveBeenCalled();
  });

  it("lists the project's dashboards with resolved creators and widget counts", async () => {
    dashboardFindManyMock.mockResolvedValue([
      {
        id: "dash-1",
        name: "Default",
        description: "Overview.",
        isDefault: true,
        createdBy: "user-1",
        createTime: CREATE_TIME,
        updateTime: UPDATE_TIME,
        _count: { widgets: 4 },
      },
      {
        id: "dash-2",
        name: "Latency",
        description: null,
        isDefault: false,
        createdBy: "user-gone",
        createTime: CREATE_TIME,
        updateTime: CREATE_TIME,
        _count: { widgets: 0 },
      },
    ]);
    // user-gone is deleted: it resolves to no row, so the creator is null.
    userFindManyMock.mockResolvedValue([
      { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
    ]);

    const res = await POST(makeRequest({ projectId: "proj-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      dashboards: [
        {
          id: "dash-1",
          name: "Default",
          description: "Overview.",
          isDefault: true,
          creator: "Ada Lovelace",
          createTime: CREATE_TIME,
          updateTime: UPDATE_TIME,
          widgetCount: 4,
        },
        {
          id: "dash-2",
          name: "Latency",
          description: null,
          isDefault: false,
          creator: null,
          createTime: CREATE_TIME,
          updateTime: CREATE_TIME,
          widgetCount: 0,
        },
      ],
    });
    // Scoped to the requested project, default dashboard first.
    expect(dashboardFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { projectId: "proj-1" },
      orderBy: [{ isDefault: "desc" }, { createTime: "asc" }],
    });
  });

  it("falls back to the creator's email when the name is empty", async () => {
    dashboardFindManyMock.mockResolvedValue([
      {
        id: "dash-1",
        name: "Default",
        description: null,
        isDefault: true,
        createdBy: "user-1",
        createTime: CREATE_TIME,
        updateTime: CREATE_TIME,
        _count: { widgets: 1 },
      },
    ]);
    userFindManyMock.mockResolvedValue([{ id: "user-1", name: "", email: "ada@example.com" }]);

    const res = await POST(makeRequest({ projectId: "proj-1" }));
    const body = (await res.json()) as { dashboards: Array<{ creator: string | null }> };

    expect(body.dashboards[0].creator).toBe("ada@example.com");
  });

  it("returns an empty list without a creator lookup when the project has no dashboards", async () => {
    dashboardFindManyMock.mockResolvedValue([]);

    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dashboards: [] });
    expect(userFindManyMock).not.toHaveBeenCalled();
  });
});
