import { describe, it, expect, vi, afterEach } from "vitest";

const mockIsBillingEnabled = vi.fn();
const mockGetSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: { workspace: { findFirst: vi.fn(), update: vi.fn() } },
  getStripeOrThrow: vi.fn(),
  getPlanConfig: vi.fn(),
  isBillingEnabled: () => mockIsBillingEnabled(),
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/billing/checkout", () => {
  it("returns 400 without hitting auth/Stripe when billing is disabled (self-host)", async () => {
    mockIsBillingEnabled.mockReturnValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws1", plan: "starter" }),
      }) as any,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Billing is disabled on this deployment");
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("proceeds past the billing gate when billing is enabled", async () => {
    mockIsBillingEnabled.mockReturnValue(true);
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });

    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws1", plan: "invalid-plan" }),
      }) as any,
    );

    // Reaches the plan-validation step (not the billing gate) — proves the
    // gate didn't short-circuit when billing is enabled.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid plan");
  });
});
