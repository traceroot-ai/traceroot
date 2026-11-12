import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("next/server", () => ({ NextRequest: class {} }));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (message: string, status: number) => Response.json({ error: message }, { status }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

const listLoopsMock = vi.fn();
const createLoopMock = vi.fn();
vi.mock("@traceroot/core", () => ({ prisma: {}, Role: { MEMBER: "MEMBER" } }));
vi.mock("@traceroot/core/loops", () => ({ listLoops: (...a: unknown[]) => listLoopsMock(...a) }));
vi.mock("@/lib/write-services/loops", () => ({
  createLoop: (...a: unknown[]) => createLoopMock(...a),
}));

import { Role } from "@traceroot/core";
import { GET, POST } from "./route";

const params = { params: Promise.resolve({ projectId: "proj-1" }) };
const getRequest = (query = "") =>
  ({ nextUrl: new URL(`http://x/api/projects/proj-1/loops${query}`) }) as unknown as Parameters<
    typeof GET
  >[0];
const postRequest = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];

beforeEach(() => {
  vi.resetAllMocks();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({
    project: { id: "proj-1", workspaceId: "ws-1", name: "P" },
  });
  listLoopsMock.mockResolvedValue({ data: [], meta: { page: 0, limit: 50, total: 0 } });
});

describe("GET .../loops", () => {
  it("lists with paging and the search term, scoped to the project", async () => {
    const res = await GET(getRequest("?search_query=%20daily%20&page=2&limit=10"), params);
    expect(res.status).toBe(200);
    expect(listLoopsMock).toHaveBeenCalledWith(
      {},
      { projectId: "proj-1", search: "daily", page: 2, limit: 10 },
    );
  });

  it("clamps the limit and falls back on junk paging", async () => {
    await GET(getRequest("?limit=9999&page=abc"), params);
    expect(listLoopsMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ limit: 200, page: 0 }),
    );
  });

  it("returns the access error without reading", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: Response.json({ error: "Project not found" }, { status: 404 }),
    });
    expect((await GET(getRequest(), params)).status).toBe(404);
    expect(listLoopsMock).not.toHaveBeenCalled();
  });
});

describe("POST .../loops", () => {
  it("requires MEMBER and never creates for a viewer", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: Response.json({ error: "Requires MEMBER role or higher" }, { status: 403 }),
    });
    const res = await POST(postRequest({ name: "x" }), params);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(403);
    expect(createLoopMock).not.toHaveBeenCalled();
  });

  it("creates through the write-service as a ui write and answers 201", async () => {
    createLoopMock.mockResolvedValue({ ok: true, created: true, data: { id: "l1" } });
    const res = await POST(postRequest({ name: "Daily", instructions: "x" }), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ loop: { id: "l1" } });
    expect(createLoopMock).toHaveBeenCalledWith({
      name: "Daily",
      instructions: "x",
      actorUserId: "user-1",
      projectId: "proj-1",
      provenance: { transport: "ui" },
    });
  });

  it("passes the service's refusal through with its status", async () => {
    createLoopMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "A Loop with this name already exists",
    });
    const res = await POST(postRequest({ name: "Daily" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A Loop with this name already exists" });
  });

  it("rejects a body that is not a JSON object", async () => {
    expect((await POST(postRequest([1]), params)).status).toBe(400);
    expect((await POST(postRequest(null), params)).status).toBe(400);
    expect(createLoopMock).not.toHaveBeenCalled();
  });
});
