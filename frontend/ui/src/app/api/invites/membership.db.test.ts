import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Opt-in against a throwaway database with the core Prisma schema applied.
const databaseUrl = process.env.WORKSPACE_MEMBERSHIP_TEST_DATABASE_URL;
const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  user: { id: "", email: "", name: "Test" },
}));
vi.mock("@traceroot/core", async (load) => {
  const actual = await load<typeof import("@traceroot/core")>();
  state.db = new actual.PrismaClient({
    datasourceUrl:
      process.env.WORKSPACE_MEMBERSHIP_TEST_DATABASE_URL ?? "postgresql://unused/unused",
  });
  return { ...actual, prisma: state.db };
});
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { ...state.user } }),
  requireWorkspaceMembership: async (userId: string, workspaceId: string) => {
    const member = await state.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return member?.role === "ADMIN"
      ? { membership: member }
      : { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  },
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
  successResponse: (data: unknown) => NextResponse.json(data),
}));
vi.mock("@/lib/email", () => ({ sendInviteEmail: vi.fn() }));
vi.mock("@/lib/signup/membership-webhook", () => ({ notifyWorkspaceMember: vi.fn() }));
vi.mock("@/lib/membership-notifications", () => ({ notifyMembershipChange: vi.fn() }));

import { POST as createInvite } from "../workspaces/[workspaceId]/invites/route";
import { POST as directAdd } from "../workspaces/[workspaceId]/members/route";
import { POST as acceptInvite } from "./[inviteId]/accept/route";

describe.skipIf(!databaseUrl)("workspace membership against Postgres", () => {
  let workspaceId: string;
  let adminId: string;
  let targetId: string;

  beforeEach(async () => {
    vi.stubEnv("ENABLE_BILLING", "true");
    workspaceId = crypto.randomUUID();
    adminId = crypto.randomUUID();
    targetId = crypto.randomUUID();
    await state.db.user.createMany({
      data: [adminId, targetId].map((id) => ({
        id,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    });
    await state.db.workspace.create({
      data: { id: workspaceId, name: "Membership test", billingPlan: "free" },
    });
    await state.db.workspaceMember.create({
      data: { id: crypto.randomUUID(), workspaceId, userId: adminId, role: "ADMIN" },
    });
    state.user = { id: adminId, email: `${adminId}@example.test`, name: "Admin" };
  });

  afterEach(async () => {
    await state.db.workspace.deleteMany({ where: { id: workspaceId } });
    await state.db.user.deleteMany({ where: { id: { in: [adminId, targetId] } } });
    vi.unstubAllEnvs();
  });
  afterAll(async () => state.db.$disconnect());

  const invite = (email: string) =>
    createInvite(
      new NextRequest("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ email, role: "VIEWER" }),
      }),
      { params: Promise.resolve({ workspaceId }) },
    );

  const accept = (id: string) =>
    acceptInvite(new NextRequest("http://localhost/api", { method: "POST" }), {
      params: Promise.resolve({ inviteId: id }),
    });

  it("cannot force membership either below the seat limit or after an invite fills it", async () => {
    for (const reserve of [false, true]) {
      if (reserve) expect((await invite(`${targetId}@example.test`)).status).toBe(201);
      for (const userId of [targetId, "unknown-user"]) {
        const response = await directAdd(
          new NextRequest("http://localhost/api", {
            method: "POST",
            body: JSON.stringify({ userId, role: "ADMIN" }),
          }),
          { params: Promise.resolve({ workspaceId }) },
        );
        expect(response.status).toBe(405);
        expect(await response.json()).toEqual({
          error: "Send an invitation to add a workspace member.",
        });
      }
      expect(await state.db.workspaceMember.count({ where: { workspaceId } })).toBe(1);
      expect(await state.db.workspaceMember.count({ where: { userId: targetId } })).toBe(0);
      expect(await state.db.invite.count({ where: { workspaceId } })).toBe(reserve ? 1 : 0);
    }
  });

  it("serializes concurrent invitations competing for the last seat", async () => {
    const responses = await Promise.all([
      invite("first@example.test"),
      invite("second@example.test"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    expect(await state.db.invite.count({ where: { workspaceId } })).toBe(1);
    expect(await state.db.workspaceMember.count({ where: { workspaceId } })).toBe(1);
  });

  it("converts the reserved seat only when its intended recipient accepts", async () => {
    const created = await invite(`${targetId}@example.test`);
    const { id } = await created.json();
    expect((await accept(id)).status).toBe(403);
    expect(await state.db.workspaceMember.count({ where: { userId: targetId } })).toBe(0);
    state.user = { id: targetId, email: `${targetId}@example.test`, name: "Recipient" };
    expect((await accept(id)).status).toBe(200);
    expect(
      await state.db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetId } },
      }),
    ).toMatchObject({ role: "VIEWER" });
    expect(await state.db.invite.count({ where: { workspaceId } })).toBe(0);
    expect(await state.db.workspaceMember.count({ where: { workspaceId } })).toBe(2);
  });

  it("consumes an invitation once under concurrent acceptance", async () => {
    const { id } = await (await invite(`${targetId}@example.test`)).json();
    state.user = { id: targetId, email: `${targetId}@example.test`, name: "Recipient" };
    const responses = await Promise.all([accept(id), accept(id)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    expect(await state.db.workspaceMember.count({ where: { workspaceId } })).toBe(2);
    expect(await state.db.invite.count({ where: { workspaceId } })).toBe(0);
  });
});
