import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, init) => ({
      status: init?.status ?? 200,
      json: async () => data,
    })),
  },
}));

const findManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    gitHubInstallation: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireWorkspaceMembership: (...args: unknown[]) => requireMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: <T>(data: T, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { GET } from "./route";

function makeRequest(workspaceId: string | null) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspaceId", workspaceId);
  return {
    nextUrl: { searchParams: params },
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  findManyMock.mockReset();
  requireAuthMock.mockReset();
  requireMembershipMock.mockReset();
});

describe("GET /api/github/status", () => {
  it("returns 401 when not authenticated", async () => {
    requireAuthMock.mockResolvedValue({
      error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
    });
    const res = await GET(makeRequest("ws_1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when workspaceId is missing", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId required" });
  });

  it("returns 403 when user is not a member of the workspace", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Not a member of this workspace" }) },
    });
    const res = await GET(makeRequest("ws_1"));
    expect(res.status).toBe(403);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns connected:false with empty list when no installs", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
    findManyMock.mockResolvedValue([]);
    const res = await GET(makeRequest("ws_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, installations: [] });
  });

  it("returns connected:true with installations", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_1" } });
    findManyMock.mockResolvedValue([
      { installationId: "1", accountLogin: "acme", createTime: new Date() },
      { installationId: "2", accountLogin: "acme-labs", createTime: new Date() },
    ]);
    const res = await GET(makeRequest("ws_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.installations).toEqual([
      { installationId: "1", accountLogin: "acme" },
      { installationId: "2", accountLogin: "acme-labs" },
    ]);
  });

  it("scopes findMany to the requested workspace", async () => {
    requireAuthMock.mockResolvedValue({ user: { id: "u_1" } });
    requireMembershipMock.mockResolvedValue({ membership: { workspaceId: "ws_42" } });
    findManyMock.mockResolvedValue([]);
    await GET(makeRequest("ws_42"));
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_42" } }),
    );
  });
});
