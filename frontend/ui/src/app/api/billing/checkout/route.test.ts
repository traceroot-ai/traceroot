import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));
vi.mock("@/lib/support/route-guard", () => ({ withImpersonationPolicy: (h: unknown) => h }));
vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => ({ user: { id: "user-1", email: "a@example.test" } }),
}));

vi.hoisted(() => {
  process.env.STRIPE_PRICE_ID_STARTER = "price_starter";
  process.env.STRIPE_PRICE_ID_PRO = "price_pro";
  process.env.STRIPE_PRICE_ID_AI_USAGE = "price_ai";
  process.env.STRIPE_PRICE_ID_RCA_USAGE = "price_rca";
  process.env.STRIPE_PRICE_ID_DETECTOR_USAGE = "price_detector";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
});

const { customersCreate, sessionsCreate, workspaceFindFirst, workspaceUpdate } = vi.hoisted(() => ({
  customersCreate: vi.fn(),
  sessionsCreate: vi.fn(),
  workspaceFindFirst: vi.fn(),
  workspaceUpdate: vi.fn(),
}));

vi.mock("@traceroot/core", async () => {
  const plans = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/plans.ts")
  >("../../../../../../packages/core/src/ee/billing/plans.ts");
  const items = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
  >("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts");
  return {
    getPlanConfig: plans.getPlanConfig,
    PlanType: plans.PlanType,
    METERED_PRICE_ENV_VARS: items.METERED_PRICE_ENV_VARS,
    prisma: { workspace: { findFirst: workspaceFindFirst, update: workspaceUpdate } },
    getStripeOrThrow: () => ({
      customers: { create: customersCreate },
      checkout: { sessions: { create: sessionsCreate } },
    }),
  };
});

import { POST } from "./route";

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  workspaceFindFirst.mockResolvedValue({ id: "ws-1", billingCustomerId: "cus_1" });
  sessionsCreate.mockResolvedValue({ url: "https://checkout.example.test/s" });
});

describe("POST /api/billing/checkout", () => {
  it("lets Stripe's hosted page take the promo code, with the plan and all three metered items", async () => {
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro" }));

    expect(res.status).toBe(200);
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.allow_promotion_codes).toBe(true);
    expect(args.line_items.map((i: { price: string }) => i.price)).toEqual([
      "price_pro",
      "price_ai",
      "price_rca",
      "price_detector",
    ]);
  });

  it("never pre-applies a discount, and ignores a promo code sent in the body", async () => {
    await POST(req({ workspaceId: "ws-1", plan: "starter", promoCode: "ANYTHING" }));

    const args = sessionsCreate.mock.calls[0][0];
    expect(args.discounts).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain("ANYTHING");
  });

  it("still rejects an invalid plan", async () => {
    const res = await POST(req({ workspaceId: "ws-1", plan: "free" }));
    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when Stripe fails", async () => {
    sessionsCreate.mockRejectedValue(new Error("boom"));
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro" }));
    expect(res.status).toBe(500);
  });
});
