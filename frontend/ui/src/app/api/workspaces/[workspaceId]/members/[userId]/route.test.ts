import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  actorId: "admin",
  authError: false,
  access: vi.fn(),
  find: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () =>
    m.authError
      ? { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
      : { user: { id: m.actorId } },
  requireWorkspaceMembership: m.access,
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
  successResponse: (data: unknown) => NextResponse.json(data),
}));
vi.mock("@traceroot/core", async () => ({
  Role: { ADMIN: "ADMIN" },
  RoleSchema: (await import("zod")).z.enum(["ADMIN", "MEMBER", "VIEWER"]),
  prisma: {
    workspaceMember: { findUnique: m.find, count: m.count, update: m.update, delete: m.remove },
  },
}));
vi.mock("@/lib/membership-notifications", () => ({ notifyMembershipChange: m.notify }));

import { PUT, DELETE } from "./route";

const context = () => ({ params: Promise.resolve({ workspaceId: "w1", userId: "target" }) });
const update = (role: string) =>
  PUT(
    new NextRequest("http://localhost/api", {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
    context(),
  );
const remove = () =>
  DELETE(new NextRequest("http://localhost/api", { method: "DELETE" }), context());

beforeEach(() => {
  vi.resetAllMocks();
  m.actorId = "admin";
  m.authError = false;
  m.access.mockResolvedValue({ membership: { role: "ADMIN" } });
  m.find.mockResolvedValue({ id: "m1", role: "MEMBER" });
  m.count.mockResolvedValue(2);
  m.update.mockResolvedValue({
    id: "m1",
    role: "VIEWER",
    updateTime: new Date(),
    user: { id: "target", email: "target@example.test", name: "Target" },
  });
  m.remove.mockResolvedValue({ id: "m1", role: "MEMBER" });
  m.notify.mockResolvedValue(undefined);
});

describe("workspace member change notifications", () => {
  it("records the actor, target and committed role change", async () => {
    const response = await update("VIEWER");
    expect(response.status).toBe(200);
    expect(m.access).toHaveBeenCalledWith("admin", "w1", "ADMIN");
    expect(m.update).toHaveBeenCalledWith({
      where: { id: "m1", role: "MEMBER" },
      data: { role: "VIEWER", updateTime: expect.any(Date) },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    expect(m.notify).toHaveBeenCalledExactlyOnceWith({
      actorUserId: "admin",
      workspaceId: "w1",
      membershipId: "m1",
      userId: "target",
      role: "VIEWER",
      previousRole: "MEMBER",
      operation: "role_changed",
    });
  });

  it("does not report a role change when the role was unchanged", async () => {
    m.find.mockResolvedValue({ id: "m1", role: "VIEWER" });
    expect((await update("VIEWER")).status).toBe(200);
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("records removal using the role actually deleted", async () => {
    m.remove.mockResolvedValue({ id: "m1", role: "ADMIN" });
    expect((await remove()).status).toBe(200);
    expect(m.notify).toHaveBeenCalledExactlyOnceWith({
      actorUserId: "admin",
      workspaceId: "w1",
      membershipId: "m1",
      userId: "target",
      role: "ADMIN",
      operation: "removed",
    });
  });

  it.each([update, () => remove()])(
    "keeps authentication and administrator checks before mutation",
    async (mutate) => {
      m.authError = true;
      expect((await mutate("VIEWER")).status).toBe(401);
      expect(m.access).not.toHaveBeenCalled();
      m.authError = false;
      m.access.mockResolvedValue({
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      });
      expect((await mutate("VIEWER")).status).toBe(403);
      expect(m.find).not.toHaveBeenCalled();
      expect(m.notify).not.toHaveBeenCalled();
    },
  );

  it.each([update, () => remove()])("does not report a nonexistent membership", async (mutate) => {
    m.find.mockResolvedValue(null);
    expect((await mutate("VIEWER")).status).toBe(404);
    expect(m.notify).not.toHaveBeenCalled();
  });

  it.each([update, () => remove()])(
    "retains the last-admin guard without a false notification",
    async (mutate) => {
      m.actorId = "target";
      m.find.mockResolvedValue({ id: "m1", role: "ADMIN" });
      m.count.mockResolvedValue(1);
      expect((await mutate("VIEWER")).status).toBe(400);
      expect(m.notify).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid JSON and invalid roles", async () => {
    expect((await update("OWNER")).status).toBe(400);
    const response = await PUT(
      new NextRequest("http://localhost/api", { method: "PUT", body: "{" }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("rejects a raced role change instead of reporting an incorrect transition", async () => {
    m.update.mockRejectedValue({ code: "P2025" });
    expect((await update("VIEWER")).status).toBe(409);
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("does not report writes that fail", async () => {
    m.update.mockRejectedValue(new Error("database unavailable"));
    await expect(update("VIEWER")).rejects.toThrow("database unavailable");
    m.remove.mockRejectedValue(new Error("database unavailable"));
    await expect(remove()).rejects.toThrow("database unavailable");
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("returns not found without a second notification when removal races", async () => {
    m.remove.mockRejectedValue({ code: "P2025" });
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Member not found" });
    expect(m.notify).not.toHaveBeenCalled();
  });
});
