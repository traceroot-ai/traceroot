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
const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberCreate: vi.fn(),
}));
vi.mock("@traceroot/core", async () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  RoleSchema: (await import("zod")).z.enum(["VIEWER", "MEMBER", "ADMIN"]),
  prisma: {
    user: { findUnique: db.userFindUnique },
    workspaceMember: {
      findMany: (...args: unknown[]) => memberFindManyMock(...args),
      findUnique: db.memberFindUnique,
      create: db.memberCreate,
    },
  },
}));
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/signup/membership-webhook", () => ({ notifyWorkspaceMember: notifyMock }));

const requireWorkspaceMembershipMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({ status, data: { error: msg } }),
  successResponse: (data: unknown) => ({ status: 200, data }),
}));

import { GET, POST } from "./route";

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

describe("POST /api/workspaces/[workspaceId]/members", () => {
  const post = (body: unknown) =>
    (
      POST as unknown as (
        req: unknown,
        ctx: { params: Promise<{ workspaceId: string }> },
      ) => Promise<{ status: number; data: unknown }>
    )({ json: async () => body }, { params: Promise.resolve({ workspaceId: "w1" }) });

  beforeEach(() => {
    notifyMock.mockReset();
    requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
    db.userFindUnique
      .mockReset()
      .mockResolvedValue({ id: "u2", email: "kai@acme.test", name: "Kai" });
    db.memberFindUnique.mockReset().mockResolvedValue(null);
    db.memberCreate
      .mockReset()
      .mockResolvedValue({ id: "m2", role: "MEMBER", createTime: new Date() });
  });

  it("reports a member an admin added as added to that workspace", async () => {
    expect((await post({ userId: "u2", role: "MEMBER" })).status).toBe(201);
    expect(notifyMock).toHaveBeenCalledWith({ userId: "u2", workspaceId: "w1", via: "added" });
  });

  it("reports nothing when the person is already a member", async () => {
    db.memberFindUnique.mockResolvedValue({ id: "m1" });
    expect((await post({ userId: "u2", role: "MEMBER" })).status).toBe(409);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
