import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
const m = vi.hoisted(() => ({
  invite: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  transaction: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: { id: "u2", email: "kai@acme.test" } }),
    errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
    successResponse: (data: unknown) => NextResponse.json(data),
  };
});
vi.mock("@traceroot/core", () => ({
  PlanType: { FREE: "free" },
  getSeatLimit: () => 3,
  canAddSeat: (_plan: string, members: number) => members < 3,
  prisma: {
    invite: { findUnique: async () => m.invite, delete: vi.fn((a: unknown) => a) },
    workspaceMember: { findUnique: async () => m.member, create: vi.fn((a: unknown) => a) },
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/signup/membership-webhook", () => ({ notifyWorkspaceMember: m.notify }));

import { POST } from "./route";

const accept = () =>
  POST(new NextRequest("http://localhost/api/invites/inv1/accept", { method: "POST" }), {
    params: Promise.resolve({ inviteId: "inv1" }),
  });

beforeEach(() => {
  m.invite = {
    id: "inv1",
    email: "kai@acme.test",
    role: "MEMBER",
    workspaceId: "w1",
    workspace: { id: "w1", name: "Acme", billingPlan: "free", _count: { members: 1 } },
  };
  m.member = null;
  m.transaction.mockReset().mockResolvedValue([]);
  m.notify.mockReset();
});

describe("accepting an invite reports the teammate's membership", () => {
  it("reports the person as joining that workspace by invite, once it is accepted", async () => {
    expect((await accept()).status).toBe(200);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith({ userId: "u2", workspaceId: "w1", via: "invite" });
  });

  it.each<[string, () => void, number]>([
    [
      "an invite for another address",
      () => (m.invite = { ...m.invite!, email: "x@acme.test" }),
      403,
    ],
    ["someone already a member", () => (m.member = { userId: "u2" }), 409],
    [
      "a full workspace",
      () =>
        (m.invite = {
          ...m.invite!,
          workspace: { id: "w1", name: "Acme", billingPlan: "free", _count: { members: 3 } },
        }),
      403,
    ],
  ])("reports nothing for %s", async (_case, arrange, status) => {
    arrange();
    expect((await accept()).status).toBe(status);
    expect(m.notify).not.toHaveBeenCalled();
  });
});
