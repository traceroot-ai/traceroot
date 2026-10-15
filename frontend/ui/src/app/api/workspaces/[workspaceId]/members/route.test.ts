import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, data }),
  },
}));

const memberFindManyMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  RoleSchema: { parse: (v: unknown) => v },
  prisma: { workspaceMember: { findMany: (...args: unknown[]) => memberFindManyMock(...args) } },
}));

const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({ status, data: { error: msg } }),
  successResponse: (data: unknown) => ({ status: 200, data }),
}));

import { GET } from "./route";

function get(workspaceId: string) {
  return (
    GET as unknown as (
      req: unknown,
      ctx: { params: Promise<{ workspaceId: string }> },
    ) => Promise<{ status: number; data: unknown }>
  )({}, { params: Promise.resolve({ workspaceId }) });
}

beforeEach(() => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "ws-demo");
  memberFindManyMock.mockReset();
  memberFindManyMock.mockResolvedValue([]);
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "VIEWER" } });
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/workspaces/[workspaceId]/members", () => {
  it("lets only admins read the member list of the demo workspace, which holds every user", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({
      error: { status: 403, data: { error: "Requires ADMIN role or higher" } },
    });
    const res = await get("ws-demo");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith("user-1", "ws-demo", "ADMIN");
    expect(res.status).toBe(403);
    expect(memberFindManyMock).not.toHaveBeenCalled();
  });

  it("lets demo admins read the scoped member payload", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
    memberFindManyMock.mockResolvedValue([
      {
        id: "m1",
        role: "VIEWER",
        createTime: "2026-10-15",
        user: { id: "u2", email: "viewer@example.com", name: "Viewer" },
      },
    ]);
    const res = await get("ws-demo");
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith("user-1", "ws-demo", "ADMIN");
    expect(memberFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-demo" } }),
    );
    expect(res.data).toEqual({
      members: [
        {
          id: "m1",
          user_id: "u2",
          email: "viewer@example.com",
          name: "Viewer",
          role: "VIEWER",
          create_time: "2026-10-15",
        },
      ],
    });
  });

  it("keeps the member list open to every member of any other workspace", async () => {
    const res = await get("ws-own");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith("user-1", "ws-own", undefined);
    expect(res.status).toBe(200);
    expect(memberFindManyMock).toHaveBeenCalled();
  });
});
