import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceFindUnique,
  userFindUnique,
  memberFindUnique,
  memberCreate,
  requireWorkspaceMembershipMock,
} = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberCreate: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      workspace: { findUnique: workspaceFindUnique },
      user: { findUnique: userFindUnique },
      workspaceMember: { findUnique: memberFindUnique, create: memberCreate },
    },
  };
});

// Auth/access helpers. The real module pulls in env-validated auth config, so
// stub the whole module: open the gates and reimplement the pure response
// helpers with NextResponse (their only behavior the handler relies on).
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: { id: "u1", email: null, name: null } }),
    requireWorkspaceMembership: requireWorkspaceMembershipMock,
    errorResponse: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    successResponse: <T>(data: T, status = 200) => NextResponse.json(data, { status }),
  };
});

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ workspaceId: "w1" }) } as never,
  );
}

describe("workspace members POST seat limit", () => {
  beforeEach(() => {
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      membership: { workspaceId: "w1", userId: "u1", role: "ADMIN" },
    });
    userFindUnique.mockReset().mockResolvedValue({ id: "u2", email: "u2@x.com", name: "U2" });
    memberFindUnique.mockReset().mockResolvedValue(null);
    memberCreate
      .mockReset()
      .mockResolvedValue({ id: "m1", role: "MEMBER", createTime: new Date() });
    workspaceFindUnique.mockReset().mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 1, invites: 0 },
    });
  });

  it("rejects at the seat limit and does not create a member", async () => {
    workspaceFindUnique.mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 2, invites: 0 },
    });
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(403);
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it("rejects when members + pending invites hit the cap", async () => {
    workspaceFindUnique.mockResolvedValue({
      id: "w1",
      billingPlan: "free",
      _count: { members: 1, invites: 1 },
    });
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(403);
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it("succeeds under the seat limit", async () => {
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(201);
    expect(memberCreate).toHaveBeenCalledTimes(1);
  });

  it("succeeds on an unlimited plan even past the free cap", async () => {
    workspaceFindUnique.mockResolvedValue({
      id: "w1",
      billingPlan: "pro",
      _count: { members: 10, invites: 0 },
    });
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(201);
  });

  it("succeeds when billing is disabled even past the free cap", async () => {
    const original = process.env.ENABLE_BILLING;
    process.env.ENABLE_BILLING = "false";
    try {
      workspaceFindUnique.mockResolvedValue({
        id: "w1",
        billingPlan: "free",
        _count: { members: 5, invites: 0 },
      });
      const res = await post({ userId: "u2", role: "MEMBER" });
      expect(res.status).toBe(201);
    } finally {
      process.env.ENABLE_BILLING = original;
    }
  });

  it("rejects non-ADMIN before ever checking the seat limit", async () => {
    const { NextResponse } = await import("next/server");
    requireWorkspaceMembershipMock.mockResolvedValue({
      error: NextResponse.json({ error: "Requires ADMIN role or higher" }, { status: 403 }),
    });
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(403);
    expect(workspaceFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a duplicate membership before ever checking the seat limit", async () => {
    memberFindUnique.mockResolvedValue({ id: "existing" });
    const res = await post({ userId: "u2", role: "MEMBER" });
    expect(res.status).toBe(409);
    expect(workspaceFindUnique).not.toHaveBeenCalled();
  });
});
