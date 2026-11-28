import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
const m = vi.hoisted(() => ({
  user: { id: "admin", email: "admin@example.com", name: "Admin" } as {
    id: string;
    email: string;
    name: string;
  } | null,
  access: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  userFind: vi.fn(),
  memberFind: vi.fn(),
  inviteFind: vi.fn(),
  workspaceFind: vi.fn(),
  create: vi.fn(),
  email: vi.fn(),
  canAddSeat: vi.fn(),
  order: [] as string[],
  active: false,
  locked: false,
}));
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () =>
      m.user
        ? { user: m.user }
        : { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
    requireWorkspaceMembership: m.access,
    errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
    successResponse: (data: unknown) => NextResponse.json(data),
  };
});
vi.mock("@traceroot/core", async () => ({
  Role: { ADMIN: "ADMIN" },
  RoleSchema: (await import("zod")).z.enum(["VIEWER", "MEMBER", "ADMIN"]),
  PlanType: { FREE: "free" },
  getSeatLimit: () => 2,
  canAddSeat: m.canAddSeat,
  prisma: { $transaction: m.transaction },
}));
vi.mock("@/lib/email", () => ({ sendInviteEmail: m.email }));
import { POST } from "./route";

const created = {
  id: "invite-1",
  email: "new@example.com",
  role: "VIEWER",
  createTime: new Date("2026-11-28T00:00:00Z"),
  invitedBy: { id: "admin", email: "admin@example.com", name: "Admin" },
  workspace: { name: "Test workspace" },
};
const workspace = (members: number, invites: number, billingPlan: string | null = "free") => ({
  id: "w1",
  billingPlan,
  _count: { members, invites },
});
const post = (body: unknown = { email: "new@example.com", role: "VIEWER" }) =>
  POST(
    new NextRequest("http://localhost/api/workspaces/w1/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ workspaceId: "w1" }) },
  );

beforeEach(() => {
  m.user = { id: "admin", email: "admin@example.com", name: "Admin" };
  m.order = [];
  m.active = false;
  m.locked = false;
  m.access.mockReset().mockResolvedValue({ membership: { role: "ADMIN" } });
  m.canAddSeat
    .mockReset()
    .mockImplementation((plan: string, count: number) => plan === "pro" || count < 2);
  m.lock.mockReset().mockImplementation(async () => {
    expect(m.active).toBe(true);
    m.locked = true;
    m.order.push("lock");
    return [];
  });
  m.userFind.mockReset().mockResolvedValue(null);
  m.memberFind.mockReset().mockResolvedValue(null);
  m.inviteFind.mockReset().mockResolvedValue(null);
  m.workspaceFind.mockReset().mockImplementation(async () => {
    expect(m.active && m.locked).toBe(true);
    m.order.push("count");
    return workspace(1, 0);
  });
  m.create.mockReset().mockImplementation(async () => {
    expect(m.active && m.locked).toBe(true);
    m.order.push("create");
    return created;
  });
  // This fake verifies the route's transaction boundary, not real database concurrency.
  m.transaction.mockReset().mockImplementation(async (run) => {
    m.active = true;
    try {
      const result = await run({
        $queryRaw: m.lock,
        user: { findUnique: m.userFind },
        workspaceMember: { findUnique: m.memberFind },
        invite: { findUnique: m.inviteFind, create: m.create },
        workspace: { findUnique: m.workspaceFind },
      });
      m.order.push("commit");
      return result;
    } finally {
      m.active = false;
      m.locked = false;
    }
  });
  m.email.mockReset().mockImplementation(async () => {
    expect(m.active).toBe(false);
    m.order.push("email");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/workspaces/[workspaceId]/invites", () => {
  it("requires authentication and workspace ADMIN access before reading invitation state", async () => {
    m.user = null;
    expect((await post()).status).toBe(401);
    expect(m.access).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
    m.user = { id: "admin", email: "admin@example.com", name: "Admin" };
    const { NextResponse } = await import("next/server");
    m.access.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    expect((await post()).status).toBe(403);
    expect(m.access).toHaveBeenCalledWith("admin", "w1", "ADMIN");
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before reserving a seat", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/w1/invites", { method: "POST", body: "{" }),
      { params: Promise.resolve({ workspaceId: "w1" }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { email: "bad", role: "VIEWER" },
    { email: "new@example.com", role: "OWNER" },
  ])("rejects invalid invitation data: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("rejects an existing workspace member before checking occupancy", async () => {
    m.userFind.mockResolvedValue({ id: "target" });
    m.memberFind.mockResolvedValue({ id: "member" });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "User is already a member of this workspace" });
    expect(m.memberFind).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "target" } },
    });
    expect(m.workspaceFind).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it("still invites an existing account which is not a member", async () => {
    m.userFind.mockResolvedValue({ id: "target" });
    expect((await post()).status).toBe(201);
    expect(m.memberFind).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "target" } },
    });
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate invite without checking occupancy or sending another email", async () => {
    m.inviteFind.mockResolvedValue({ id: "pending" });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An invite has already been sent to this email",
    });
    expect(m.workspaceFind).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it("handles a workspace removed before reservation", async () => {
    m.workspaceFind.mockResolvedValue(null);
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it.each([
    [2, 0],
    [1, 1],
    [0, 2],
  ])("counts %i members and %i pending invitations against the cap", async (members, invites) => {
    m.workspaceFind.mockResolvedValue(workspace(members, invites));
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your free plan is limited to 2 seats. Upgrade your plan to invite more members.",
    });
    expect(m.canAddSeat).toHaveBeenCalledWith("free", 2);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it("locks before counting and creating, and sends email only after commit", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(m.canAddSeat).toHaveBeenCalledWith("free", 1);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.lock).toHaveBeenCalledTimes(1);
    const [sql, id] = m.lock.mock.calls[0];
    expect(sql.join("?")).toBe("SELECT id FROM workspaces WHERE id = ? FOR UPDATE");
    expect(id).toBe("w1");
    expect(m.order).toEqual(["lock", "count", "create", "commit", "email"]);
    expect(await response.json()).toEqual({
      id: "invite-1",
      email: "new@example.com",
      role: "VIEWER",
      create_time: created.createTime.toISOString(),
      invited_by: { id: "admin", email: "admin@example.com", name: "Admin" },
    });
  });

  it("uses canonical email and requested role for storage and notification", async () => {
    m.create.mockResolvedValue({ ...created, role: "ADMIN" });
    const response = await post({ email: "New@Example.COM", role: "ADMIN" });
    expect(response.status).toBe(201);
    expect(m.userFind).toHaveBeenCalledWith({ where: { email: "new@example.com" } });
    expect(m.inviteFind).toHaveBeenCalledWith({
      where: { email_workspaceId: { email: "new@example.com", workspaceId: "w1" } },
    });
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          id: expect.any(String),
          email: "new@example.com",
          workspaceId: "w1",
          role: "ADMIN",
          invitedByUserId: "admin",
        },
      }),
    );
    expect(m.email).toHaveBeenCalledExactlyOnceWith({
      to: "new@example.com",
      inviterName: "Admin",
      inviterEmail: "admin@example.com",
      workspaceName: "Test workspace",
      inviteId: "invite-1",
      role: "ADMIN",
    });
    expect((await response.json()).role).toBe("ADMIN");
  });

  it("uses the stored plan, falling back to free only when it is absent", async () => {
    m.workspaceFind.mockResolvedValue(workspace(20, 4, "pro"));
    expect((await post()).status).toBe(201);
    expect(m.canAddSeat).toHaveBeenLastCalledWith("pro", 24);
    m.workspaceFind.mockResolvedValue(workspace(1, 0, null));
    expect((await post()).status).toBe(201);
    expect(m.canAddSeat).toHaveBeenLastCalledWith("free", 1);
  });

  it("returns a conflict for a database uniqueness race", async () => {
    m.create.mockRejectedValue({ code: "P2002" });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An invite has already been sent to this email",
    });
    expect(m.email).not.toHaveBeenCalled();
  });

  it("propagates other transaction failures without sending email", async () => {
    const error = new Error("database unavailable");
    m.create.mockRejectedValue(error);
    await expect(post()).rejects.toBe(error);
    expect(m.email).not.toHaveBeenCalled();
  });

  it("does not fail a committed invitation when SMTP fails", async () => {
    const error = new Error("SMTP unavailable");
    m.email.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post();
    expect(response.status).toBe(201);
    expect((await response.json()).id).toBe("invite-1");
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.order).toContain("commit");
    expect(log).toHaveBeenCalledWith("[Invite] Failed to send invitation email:", error);
  });

  it("handles an absent inviter profile without exposing an uncommitted result", async () => {
    m.user = { id: "admin", email: "", name: "" };
    m.create.mockResolvedValue({ ...created, invitedBy: null });
    const response = await post();
    expect(response.status).toBe(201);
    expect((await response.json()).invited_by).toBeNull();
    expect(m.email).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: "A team member", inviterEmail: "" }),
    );
  });
});
