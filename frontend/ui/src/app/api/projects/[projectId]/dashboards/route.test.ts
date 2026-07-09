import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));

const dashboardFindManyMock = vi.fn();
const dashboardCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    dashboard: {
      findMany: (...args: unknown[]) => dashboardFindManyMock(...args),
      create: (...args: unknown[]) => dashboardCreateMock(...args),
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

import { GET, POST } from "./route";

function makeGetRequest() {
  return {} as Parameters<typeof GET>[0];
}

function makePostRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function makeParams(projectId = "proj-1") {
  return { params: Promise.resolve({ projectId }) };
}

beforeEach(() => {
  dashboardFindManyMock.mockReset();
  dashboardCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  // Default: authenticated with project access.
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
});

describe("GET /dashboards — existing dashboards", () => {
  it("returns existing dashboards without seeding when dashboards already exist", async () => {
    const existing = [
      {
        id: "dash-1",
        name: "Overview",
        description: null,
        isDefault: true,
        updateTime: new Date(),
      },
    ];
    dashboardFindManyMock.mockResolvedValue(existing);

    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
    // create must never have been called
    expect(dashboardCreateMock).not.toHaveBeenCalled();
    // findMany called exactly once (no re-read needed)
    expect(dashboardFindManyMock).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(dashboardFindManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(dashboardFindManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /dashboards — lazy seeding (no existing dashboards)", () => {
  it("seeds default dashboard: create called once with correct id, isDefault=true, >=7 widgets, layout[i].i === widgets.create[i].id", async () => {
    // First findMany returns empty (triggers seed); second returns seeded list.
    dashboardFindManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "default_proj-1",
        name: "Overview",
        description: null,
        isDefault: true,
        updateTime: new Date(),
      },
    ]);
    dashboardCreateMock.mockResolvedValue({});

    const res = await GET(makeGetRequest(), makeParams("proj-1"));
    expect(res.status).toBe(200);

    expect(dashboardCreateMock).toHaveBeenCalledTimes(1);
    const { data } = dashboardCreateMock.mock.calls[0][0] as {
      data: {
        id: string;
        isDefault: boolean;
        layout: Array<{ i: string }>;
        widgets: { create: Array<{ id: string }> };
      };
    };

    expect(data.id).toBe("default_proj-1");
    expect(data.isDefault).toBe(true);
    expect(data.widgets.create.length).toBeGreaterThanOrEqual(7);

    // Every layout[i].i must equal widgets.create[i].id
    data.layout.forEach((layoutItem, idx) => {
      expect(layoutItem.i).toBe(data.widgets.create[idx].id);
    });

    // Re-read happens after creation
    expect(dashboardFindManyMock).toHaveBeenCalledTimes(2);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("swallows PK conflict (P2002) and still returns dashboards", async () => {
    dashboardFindManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "default_proj-1",
        name: "Overview",
        description: null,
        isDefault: true,
        updateTime: new Date(),
      },
    ]);
    dashboardCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`id`)", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    );

    const res = await GET(makeGetRequest(), makeParams("proj-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("propagates non-PK-clash errors from dashboard.create", async () => {
    dashboardFindManyMock.mockResolvedValueOnce([]);
    dashboardCreateMock.mockRejectedValue(new Error("Database connection lost"));

    await expect(GET(makeGetRequest(), makeParams("proj-1"))).rejects.toThrow(
      "Database connection lost",
    );
  });
});

describe("POST /dashboards — create a named dashboard", () => {
  it("rejects empty name with 400", async () => {
    const res = await POST(makePostRequest({ name: "" }), makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only name with 400", async () => {
    const res = await POST(makePostRequest({ name: "   " }), makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("rejects missing name with 400", async () => {
    const res = await POST(makePostRequest({}), makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("creates and returns 201 with a valid name", async () => {
    const created = {
      id: "dash-new",
      name: "My Dashboard",
      description: null,
      projectId: "proj-1",
      isDefault: false,
    };
    dashboardCreateMock.mockResolvedValue(created);

    const res = await POST(makePostRequest({ name: "My Dashboard" }), makeParams());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dashboard: typeof created };
    expect(body.dashboard).toEqual(created);
    expect(dashboardCreateMock).toHaveBeenCalledTimes(1);

    const { data } = dashboardCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    // isDefault must NOT be accepted from the request body
    expect(data.isDefault).toBeUndefined();
    expect(data.name).toBe("My Dashboard");
  });

  it("trims leading/trailing whitespace from name", async () => {
    dashboardCreateMock.mockResolvedValue({ id: "dash-x", name: "Trimmed" });

    await POST(makePostRequest({ name: "  Trimmed  " }), makeParams());

    const { data } = dashboardCreateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.name).toBe("Trimmed");
  });

  it("rejects non-string description with 400", async () => {
    const res = await POST(makePostRequest({ name: "Valid", description: 123 }), makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("accepts null description", async () => {
    dashboardCreateMock.mockResolvedValue({ id: "dash-y", name: "Valid" });
    const res = await POST(makePostRequest({ name: "Valid", description: null }), makeParams());
    expect(res.status).toBe(201);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await POST(makePostRequest({ name: "x" }), makeParams());
    expect(res.status).toBe(401);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks project access", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await POST(makePostRequest({ name: "x" }), makeParams());
    expect(res.status).toBe(403);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a null body (non-object JSON)", async () => {
    const req = {
      json: async () => null,
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an array body (non-object JSON)", async () => {
    const req = {
      json: async () => ["a", "b"],
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /dashboards — name length cap", () => {
  it("rejects a name longer than 50 characters", async () => {
    const res = (await POST(
      makePostRequest({ name: "x".repeat(51) }),
      makeParams(),
    )) as unknown as { status: number; json: () => Promise<unknown> };
    expect(res.status).toBe(400);
    expect(dashboardCreateMock).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 50 characters", async () => {
    dashboardCreateMock.mockResolvedValue({ id: "d-new" });
    const res = (await POST(
      makePostRequest({ name: "x".repeat(50) }),
      makeParams(),
    )) as unknown as { status: number; json: () => Promise<unknown> };
    expect(res.status).toBe(201);
  });
});
