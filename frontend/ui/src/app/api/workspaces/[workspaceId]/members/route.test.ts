import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      data,
      headers: new Headers(),
    }),
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
const auth = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => (auth.error ? { error: auth.error } : { user: { id: "user-1" } }),
  requireWorkspaceMembership: (...args: unknown[]) => requireWorkspaceMembershipMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    data: { error: msg },
    headers: new Headers(),
  }),
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
  auth.error = null;
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
    POST({ json: vi.fn().mockResolvedValue(body) } as never, {
      params: Promise.resolve({ workspaceId: "w1" }),
    });

  beforeEach(() => {
    notifyMock.mockReset();
    requireWorkspaceMembershipMock.mockResolvedValue({ membership: { role: "ADMIN" } });
    db.userFindUnique.mockReset();
    db.memberFindUnique.mockReset();
    db.memberCreate.mockReset();
  });

  it.each([
    { userId: "existing-user", role: "ADMIN" },
    { userId: "unknown-user", role: "VIEWER" },
    { userId: "already-member", role: "MEMBER" },
    { inviteId: "pending-invite", userId: "another-user", role: "ADMIN" },
    {},
    null,
  ])("requires an invitation without resolving the supplied account: %j", async (body) => {
    db.userFindUnique.mockResolvedValue({
      id: "existing-user",
      email: "private@example.com",
      name: "Private",
    });
    db.memberCreate.mockResolvedValue({ id: "new-membership", role: "ADMIN" });
    const response = await post(body);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect((response as unknown as { data: unknown }).data).toEqual({
      error: "Send an invitation to add a workspace member.",
    });
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith("user-1", "w1", "ADMIN");
    expect(db.userFindUnique).not.toHaveBeenCalled();
    expect(db.memberFindUnique).not.toHaveBeenCalled();
    expect(db.memberCreate).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("retains authentication and workspace authorization", async () => {
    auth.error = { status: 401 };
    expect((await post({ userId: "u2", role: "ADMIN" })).status).toBe(401);
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
    auth.error = null;
    requireWorkspaceMembershipMock.mockResolvedValue({ error: { status: 403 } });
    expect((await post({ userId: "u2", role: "ADMIN" })).status).toBe(403);
    expect(db.userFindUnique).not.toHaveBeenCalled();
    expect(db.memberCreate).not.toHaveBeenCalled();
  });
});
