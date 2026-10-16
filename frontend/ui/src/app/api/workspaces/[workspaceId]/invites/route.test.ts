import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceFindUnique,
  userFindUnique,
  memberFindUnique,
  inviteFindUnique,
  inviteCreate,
  requireWorkspaceMembershipMock,
  sendInviteEmailMock,
} = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteCreate: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
  sendInviteEmailMock: vi.fn(),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      workspace: { findUnique: workspaceFindUnique },
      user: { findUnique: userFindUnique },
      workspaceMember: { findUnique: memberFindUnique },
      invite: { findUnique: inviteFindUnique, create: inviteCreate },
    },
  };
});

// Auth/access helpers. The real module pulls in env-validated auth config, so
// stub the whole module: open the gates and reimplement the pure response
// helpers with NextResponse (their only behavior the handler relies on).
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: { id: "u1", email: "admin@x.com", name: "Admin" } }),
    requireWorkspaceMembership: requireWorkspaceMembershipMock,
    errorResponse: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    successResponse: <T>(data: T, status = 200) => NextResponse.json(data, { status }),
  };
});

vi.mock("@/lib/email", () => ({
  sendInviteEmail: sendInviteEmailMock,
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ workspaceId: "w1" }) } as never,
  );
}

describe("workspace invites POST seat limit", () => {
  beforeEach(() => {
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      membership: { workspaceId: "w1", userId: "u1", role: "ADMIN" },
    });
    userFindUnique.mockReset().mockResolvedValue(null);
    memberFindUnique.mockReset().mockResolvedValue(null);
    inviteFindUnique.mockReset().mockResolvedValue(null);
    inviteCreate.mockReset().mockResolvedValue({
      id: "inv1",
      email: "new@x.com",
      role: "MEMBER",
      createTime: new Date(),
      invitedBy: null,
      workspace: { name: "Acme" },
    });
    sendInviteEmailMock.mockReset().mockResolvedValue(undefined);
    workspaceFindUnique.mockReset().mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 1, invites: 0 },
    });
  });

  it("rejects at the seat limit and does not create an invite", async () => {
    workspaceFindUnique.mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 2, invites: 0 },
    });
    const res = await post({ email: "new@x.com", role: "MEMBER" });
    expect(res.status).toBe(403);
    expect(inviteCreate).not.toHaveBeenCalled();
  });

  it("rejects when members + pending invites hit the cap", async () => {
    workspaceFindUnique.mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 1, invites: 1 },
    });
    const res = await post({ email: "new@x.com", role: "MEMBER" });
    expect(res.status).toBe(403);
    expect(inviteCreate).not.toHaveBeenCalled();
  });

  it("succeeds under the seat limit", async () => {
    const res = await post({ email: "new@x.com", role: "MEMBER" });
    expect(res.status).toBe(201);
    expect(inviteCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects when the target email already belongs to a member", async () => {
    userFindUnique.mockResolvedValue({ id: "u2", email: "new@x.com" });
    memberFindUnique.mockResolvedValue({ id: "existing" });
    const res = await post({ email: "new@x.com", role: "MEMBER" });
    expect(res.status).toBe(409);
    expect(workspaceFindUnique).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate invite for the same email before checking the seat limit", async () => {
    inviteFindUnique.mockResolvedValue({ id: "inv-existing" });
    const res = await post({ email: "new@x.com", role: "MEMBER" });
    expect(res.status).toBe(409);
    expect(workspaceFindUnique).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
  });
});
