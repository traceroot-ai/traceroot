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

const dashboardFindFirstMock = vi.fn();
const userFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    dashboard: {
      findFirst: (...args: unknown[]) => dashboardFindFirstMock(...args),
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
  dashboardFindFirstMock.mockReset();
  userFindManyMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/project-dashboard", () => {
  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ projectId: "proj-1", dashboardId: "dash-1" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(dashboardFindFirstMock).not.toHaveBeenCalled();
  });

  it("rejects a missing dashboardId with a 400", async () => {
    const res = await POST(makeRequest({ projectId: "proj-1" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "dashboardId is required" });
  });

  it("returns the dashboard with its widgets in creation order", async () => {
    dashboardFindFirstMock.mockResolvedValue({
      id: "dash-1",
      name: "Default",
      description: "Overview.",
      isDefault: true,
      createdBy: "user-1",
      createTime: CREATE_TIME,
      updateTime: UPDATE_TIME,
      widgets: [
        {
          id: "w-1",
          title: "Cost over time",
          type: "query",
          spec: { view: "spans" },
          createTime: CREATE_TIME,
        },
      ],
    });
    userFindManyMock.mockResolvedValue([
      { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
    ]);

    const res = await POST(makeRequest({ projectId: "proj-1", dashboardId: "dash-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      dashboard: {
        id: "dash-1",
        name: "Default",
        description: "Overview.",
        isDefault: true,
        creator: "Ada Lovelace",
        createTime: CREATE_TIME,
        updateTime: UPDATE_TIME,
        widgets: [
          {
            id: "w-1",
            title: "Cost over time",
            type: "query",
            spec: { view: "spans" },
            createTime: CREATE_TIME,
          },
        ],
      },
    });
    // The lookup is scoped through the project id — a foreign dashboard
    // simply isn't found — and widgets come back in creation order.
    expect(dashboardFindFirstMock.mock.calls[0][0]).toMatchObject({
      where: { id: "dash-1", projectId: "proj-1" },
      select: { widgets: { orderBy: { createTime: "asc" } } },
    });
  });

  it("answers 404 for a dashboard outside the project", async () => {
    dashboardFindFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ projectId: "proj-1", dashboardId: "foreign-dash" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Dashboard not found" });
    expect(userFindManyMock).not.toHaveBeenCalled();
  });
});
