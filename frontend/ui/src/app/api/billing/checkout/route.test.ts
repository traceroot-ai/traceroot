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

const { customersCreate, sessionsCreate, promoList, workspaceFindFirst, workspaceUpdate } =
  vi.hoisted(() => ({
    customersCreate: vi.fn(),
    sessionsCreate: vi.fn(),
    promoList: vi.fn(),
    workspaceFindFirst: vi.fn(),
    workspaceUpdate: vi.fn(),
  }));

vi.mock("@traceroot/core", async () => {
  const core = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/promoCodes.ts")
  >("../../../../../../packages/core/src/ee/billing/promoCodes.ts");
  const plans = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/plans.ts")
  >("../../../../../../packages/core/src/ee/billing/plans.ts");
  const items = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
  >("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts");
  return {
    ...core,
    getPlanConfig: plans.getPlanConfig,
    PlanType: plans.PlanType,
    METERED_PRICE_ENV_VARS: items.METERED_PRICE_ENV_VARS,
    prisma: { workspace: { findFirst: workspaceFindFirst, update: workspaceUpdate } },
    getStripeOrThrow: () => ({
      customers: { create: customersCreate },
      checkout: { sessions: { create: sessionsCreate } },
      promotionCodes: { list: promoList },
    }),
  };
});

import { POST } from "./route";

const req = (body: unknown) => ({ json: async () => body }) as never;

const promo = (plan: string, over: Record<string, unknown> = {}) => ({
  id: "promo_1",
  active: true,
  expires_at: null,
  coupon: { valid: true, metadata: { plan } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  workspaceFindFirst.mockResolvedValue({ id: "ws-1", billingCustomerId: "cus_1" });
  sessionsCreate.mockResolvedValue({ url: "https://checkout.example/test" });
});

describe("POST /api/billing/checkout promo codes", () => {
  it("without a code, creates the session exactly as before (no discounts, no promo box)", async () => {
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro" }));
    expect(res.status).toBe(200);
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.discounts).toBeUndefined();
    expect(args.allow_promotion_codes).toBeUndefined();
    expect(args.payment_method_collection).toBeUndefined();
    expect(promoList).not.toHaveBeenCalled();
  });

  it("applies a valid code for the plan, keeping all three metered items", async () => {
    promoList.mockResolvedValue({ data: [promo("pro")] });
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro", promoCode: " LAUNCH " }));
    expect(res.status).toBe(200);
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.discounts).toEqual([{ promotion_code: "promo_1" }]);
    expect(args.line_items.map((i: { price: string }) => i.price)).toEqual([
      "price_pro",
      "price_ai",
      "price_rca",
      "price_detector",
    ]);
    expect(promoList).toHaveBeenCalledWith(expect.objectContaining({ code: "LAUNCH" }));
  });

  it("rejects a code made for another plan before creating anything", async () => {
    workspaceFindFirst.mockResolvedValue({ id: "ws-1", billingCustomerId: null });
    promoList.mockResolvedValue({ data: [promo("starter")] });
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro", promoCode: "LAUNCH" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "wrong_plan" });
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects an expired code and an unknown code", async () => {
    promoList.mockResolvedValue({ data: [promo("pro", { active: false, expires_at: 1 })] });
    let res = await POST(req({ workspaceId: "ws-1", plan: "pro", promoCode: "OLD" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "expired" });

    promoList.mockResolvedValue({ data: [] });
    res = await POST(req({ workspaceId: "ws-1", plan: "pro", promoCode: "NOPE" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid" });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("treats a blank code as no code", async () => {
    const res = await POST(req({ workspaceId: "ws-1", plan: "pro", promoCode: "  " }));
    expect(res.status).toBe(200);
    expect(promoList).not.toHaveBeenCalled();
    expect(sessionsCreate.mock.calls[0][0].discounts).toBeUndefined();
  });
});
