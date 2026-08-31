import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockRequireProjectAuth = vi.fn();
const mockDashboardFindMany = vi.fn();
const mockDashboardCreate = vi.fn();
const mockUserFindMany = vi.fn();

vi.mock("@/lib/route-helpers", () => ({
  requireProjectAuth: (...a: unknown[]) => mockRequireProjectAuth(...a),
  parseJsonObject: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: unknown) => new Response(JSON.stringify(d), { status: 200 }),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    dashboard: {
      findMany: (...a: unknown[]) => mockDashboardFindMany(...a),
      create: (...a: unknown[]) => mockDashboardCreate(...a),
    },
    user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
  },
  Role: { MEMBER: "MEMBER" },
}));

import { GET } from "../route";

const dashboardRow = {
  id: "default_p1",
  name: "Default",
  description: "Auto-created overview of traces, cost, tokens, and latency.",
  isDefault: true,
  createdBy: "u1",
  createTime: new Date(0),
  updateTime: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireProjectAuth.mockResolvedValue({
    user: { id: "u1" },
    params: { projectId: "p1" },
  });
  mockUserFindMany.mockResolvedValue([{ id: "u1", name: "User One", email: "u1@example.com" }]);
});

const get = () =>
  GET(new Request("http://localhost/") as never, {
    params: Promise.resolve({ projectId: "p1" }),
  });

describe("GET dashboards (lazy seed)", () => {
  it("seeds the Default dashboard when the project has none", async () => {
    mockDashboardFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([dashboardRow]);
    mockDashboardCreate.mockResolvedValue({});

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].isDefault).toBe(true);

    expect(mockDashboardCreate).toHaveBeenCalledTimes(1);
    const { data } = mockDashboardCreate.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        id: "default_p1",
        projectId: "p1",
        name: "Default",
        isDefault: true,
        createdBy: "u1",
        widgets: { create: expect.any(Array) },
      }),
    );
  });

  it("swallows the concurrent-first-visit unique clash and returns the list", async () => {
    mockDashboardFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([dashboardRow]);
    mockDashboardCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("clash", {
        code: "P2002",
        clientVersion: "0",
      }),
    );

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it("does not seed when dashboards already exist", async () => {
    mockDashboardFindMany.mockResolvedValue([dashboardRow]);

    const res = await get();
    expect(res.status).toBe(200);
    expect(mockDashboardCreate).not.toHaveBeenCalled();
  });
});
