import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route's own checks; the shared impersonation policy has its own tests.
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const m = vi.hoisted(() => ({
  user: { id: "u1", email: "Kai@Acme.test", name: "Kai" } as { id: string; email: string } | null,
  account: { emailVerified: false, accounts: [] as { providerId: string }[] } as {
    emailVerified: boolean;
    accounts: { providerId: string }[];
  } | null,
  invite: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  transaction: vi.fn(),
  memberCreate: vi.fn((args: unknown) => ({ create: args })),
  inviteDelete: vi.fn((args: unknown) => ({ delete: args })),
}));

vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () =>
      m.user
        ? { user: m.user }
        : { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
    errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
    successResponse: (data: unknown) => NextResponse.json(data),
  };
});
vi.mock("@traceroot/core", () => ({
  PlanType: { FREE: "free" },
  getSeatLimit: () => 3,
  canAddSeat: (_plan: string, members: number) => members < 3,
  prisma: {
    user: { findUnique: async () => m.account },
    invite: { findUnique: async () => m.invite, delete: m.inviteDelete },
    workspaceMember: { findUnique: async () => m.member, create: m.memberCreate },
    $transaction: m.transaction,
  },
}));

import { POST } from "./route";

const accept = () =>
  POST(new NextRequest("http://localhost/api/invites/inv1/accept", { method: "POST" }), {
    params: Promise.resolve({ inviteId: "inv1" }),
  });

beforeEach(() => {
  m.user = { id: "u1", email: "Kai@Acme.test" };
  m.account = { emailVerified: false, accounts: [{ providerId: "credential" }] };
  m.invite = {
    id: "inv1",
    email: "kai@acme.test",
    role: "MEMBER",
    workspaceId: "w1",
    workspace: { id: "w1", name: "Acme", billingPlan: "free", _count: { members: 1 } },
  };
  m.member = null;
  m.transaction.mockReset().mockResolvedValue([]);
  m.memberCreate.mockClear();
  m.inviteDelete.mockClear();
});

describe("POST /api/invites/[inviteId]/accept", () => {
  it("accepts for an account that signed up with this address and a password", async () => {
    const response = await accept();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { id: "w1" }, role: "MEMBER" });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.memberCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: "w1", userId: "u1", role: "MEMBER" }),
    });
  });

  it("accepts for a sign-in whose provider verified the address", async () => {
    m.account = { emailVerified: true, accounts: [{ providerId: "github" }] };
    expect((await accept()).status).toBe(200);
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a GitHub account whose address was never verified", [{ providerId: "github" }]],
    ["an account with no sign-in method that confirms its address", []],
  ])("refuses %s, and changes nothing", async (_case, accounts) => {
    m.account = { emailVerified: false, accounts };
    const response = await accept();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/verify your email address/i);
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.inviteDelete).not.toHaveBeenCalled();
  });

  it("refuses an invite sent to another address, before anything else", async () => {
    m.invite = { ...m.invite!, email: "someone@acme.test" };
    m.account = { emailVerified: true, accounts: [] };
    const response = await accept();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("This invite is not for your email address");
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("refuses a missing account record", async () => {
    m.account = null;
    expect((await accept()).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("asks a visitor to sign in, and says when the invite is gone", async () => {
    m.user = null;
    expect((await accept()).status).toBe(401);
    m.user = { id: "u1", email: "kai@acme.test" };
    m.invite = null;
    expect((await accept()).status).toBe(404);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("keeps the existing member and seat rules", async () => {
    m.member = { userId: "u1" };
    expect((await accept()).status).toBe(409);
    m.member = null;
    m.invite = {
      ...m.invite!,
      workspace: { id: "w1", name: "Acme", billingPlan: "free", _count: { members: 3 } },
    };
    expect((await accept()).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});
