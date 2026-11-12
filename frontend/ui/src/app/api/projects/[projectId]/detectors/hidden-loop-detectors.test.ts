import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("next/server", () => ({ NextRequest: class {} }));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    detector: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
  },
}));
vi.mock("@traceroot/core", () => ({
  prisma: prismaMock,
  Role: { MEMBER: "MEMBER" },
  detectorModelProblem: vi.fn(),
  listWorkspaceModels: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireProjectAccess: async () => ({ project: { id: "proj-1", workspaceId: "ws-1", name: "P" } }),
  errorResponse: (message: string, status: number) => Response.json({ error: message }, { status }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

import { GET as list } from "./route";
import { GET as one } from "./[detectorId]/route";

// A Loop's hidden detector is an implementation detail of the Loop: the
// detector pages must not list it, open it, or let a request find it by id.
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.detector.findMany.mockResolvedValue([]);
  prismaMock.detector.count.mockResolvedValue(0);
});

describe("detector reads skip Loop detectors", () => {
  it("leaves them out of the list, with and without a search term", async () => {
    const req = (q: string) => ({ nextUrl: new URL(`http://x/api/detectors${q}`) }) as never;
    const params = { params: Promise.resolve({ projectId: "proj-1" }) };
    await list(req(""), params);
    expect(prismaMock.detector.findMany.mock.calls[0][0].where).toEqual({
      projectId: "proj-1",
      template: { not: "loop" },
    });
    await list(req("?search_query=daily"), params);
    expect(prismaMock.detector.findMany.mock.calls[1][0].where).toMatchObject({
      projectId: "proj-1",
      template: { not: "loop" },
    });
  });

  it("answers 404 for a Loop's detector fetched by id", async () => {
    prismaMock.detector.findFirst.mockResolvedValue(null);
    const res = await one({} as never, {
      params: Promise.resolve({ projectId: "proj-1", detectorId: "det-loop" }),
    });
    expect(res.status).toBe(404);
    expect(prismaMock.detector.findFirst.mock.calls[0][0].where).toEqual({
      id: "det-loop",
      projectId: "proj-1",
      template: { not: "loop" },
    });
  });
});
