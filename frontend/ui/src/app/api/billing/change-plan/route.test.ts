import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));
vi.mock("@/lib/support/route-guard", () => ({ withImpersonationPolicy: (h: unknown) => h }));
vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => ({ user: { id: "user-1" } }),
}));

vi.hoisted(() => {
  process.env.STRIPE_PRICE_ID_STARTER = "price_starter";
  process.env.STRIPE_PRICE_ID_PRO = "price_pro";
  process.env.STRIPE_PRICE_ID_AI_USAGE = "price_ai";
  process.env.STRIPE_PRICE_ID_RCA_USAGE = "price_rca";
  process.env.STRIPE_PRICE_ID_DETECTOR_USAGE = "price_detector";
});

const m = vi.hoisted(() => ({
  subRetrieve: vi.fn(),
  subUpdate: vi.fn(),
  schedCreate: vi.fn(),
  schedUpdate: vi.fn(),
  schedRelease: vi.fn(),
  findFirst: vi.fn(),
  wsUpdate: vi.fn(),
}));

vi.mock("@traceroot/core", async () => {
  const base = "../../../../../../packages/core/src/ee/billing/";
  const plans = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/plans.ts")
  >(`${base}plans.ts`);
  const items = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
  >(`${base}subscriptionItems.ts`);
  const promo = await vi.importActual<
    typeof import("../../../../../../packages/core/src/ee/billing/promoCodes.ts")
  >(`${base}promoCodes.ts`);
  return {
    ...promo,
    getPlanConfig: plans.getPlanConfig,
    isUpgrade: plans.isUpgrade,
    PlanType: plans.PlanType,
    METERED_PRICE_ENV_VARS: items.METERED_PRICE_ENV_VARS,
    getMeteredPriceIds: items.getMeteredPriceIds,
    findPlanItem: items.findPlanItem,
    prisma: { workspace: { findFirst: m.findFirst, update: m.wsUpdate } },
    getStripeOrThrow: () => ({
      subscriptions: { retrieve: m.subRetrieve, update: m.subUpdate },
      subscriptionSchedules: {
        create: m.schedCreate,
        update: m.schedUpdate,
        release: m.schedRelease,
      },
    }),
  };
});

import { POST } from "./route";

const req = (body: unknown) => ({ json: async () => body }) as never;
const END = 1_900_000_000;

function subscription(planPrice: string, discounts: unknown[]) {
  const item = (id: string, price: string) => ({ id, price: { id: price }, quantity: 1 });
  return {
    id: "sub_1",
    status: "active",
    schedule: null,
    cancel_at_period_end: false,
    current_period_end: END,
    discounts,
    items: {
      data: [
        item("si_plan", planPrice),
        item("si_ai", "price_ai"),
        item("si_rca", "price_rca"),
        item("si_det", "price_detector"),
      ],
    },
  };
}
const discount = (id: string, plan?: string) => ({
  id,
  coupon: { metadata: plan ? { plan } : {} },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.subUpdate.mockResolvedValue({ id: "sub_1", status: "active", items: { data: [] } });
  m.schedCreate.mockResolvedValue({ id: "sub_sched_1", phases: [{ start_date: END - 100 }] });
});

function workspace(plan: string) {
  m.findFirst.mockResolvedValue({ id: "ws-1", billingPlan: plan, billingSubscriptionId: "sub_1" });
}

describe("POST /api/billing/change-plan discounts", () => {
  it("upgrade ends a discount that belongs to the old plan, in the same update", async () => {
    workspace("starter");
    m.subRetrieve.mockResolvedValue(subscription("price_starter", [discount("di_s", "starter")]));
    const res = await POST(req({ workspaceId: "ws-1", newPlan: "pro" }));
    expect(res.status).toBe(200);
    expect(m.subRetrieve).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({ expand: ["discounts"] }),
    );
    expect(m.subUpdate.mock.calls[0][1].discounts).toBe("");
  });

  it("upgrade keeps a discount tied to the new plan and untagged ones", async () => {
    workspace("starter");
    m.subRetrieve.mockResolvedValue(
      subscription("price_starter", [discount("di_p", "pro"), discount("di_manual")]),
    );
    await POST(req({ workspaceId: "ws-1", newPlan: "pro" }));
    expect(m.subUpdate.mock.calls[0][1].discounts).toEqual([
      { discount: "di_p" },
      { discount: "di_manual" },
    ]);
  });

  it("upgrade without any discount does not touch discounts", async () => {
    workspace("starter");
    m.subRetrieve.mockResolvedValue(subscription("price_starter", []));
    await POST(req({ workspaceId: "ws-1", newPlan: "pro" }));
    expect("discounts" in m.subUpdate.mock.calls[0][1]).toBe(false);
  });

  it("scheduled downgrade carries the active discount in the current phase only", async () => {
    workspace("pro");
    m.subRetrieve.mockResolvedValue(subscription("price_pro", [discount("di_p", "pro")]));
    const res = await POST(req({ workspaceId: "ws-1", newPlan: "starter" }));
    expect(res.status).toBe(200);
    const { phases } = m.schedUpdate.mock.calls[0][1];
    expect(phases[0].discounts).toEqual([{ discount: "di_p" }]);
    expect(phases[1].discounts).toBeUndefined();
    // metered items are still in both phases
    for (const p of phases) {
      expect(p.items.map((i: { price: string }) => i.price)).toEqual(
        expect.arrayContaining(["price_ai", "price_rca", "price_detector"]),
      );
    }
    expect(phases[1].items[0].price).toBe("price_starter");
  });

  it("scheduled downgrade without a discount behaves as before", async () => {
    workspace("pro");
    m.subRetrieve.mockResolvedValue(subscription("price_pro", []));
    await POST(req({ workspaceId: "ws-1", newPlan: "starter" }));
    const { phases } = m.schedUpdate.mock.calls[0][1];
    expect(phases[0].discounts).toBeUndefined();
    expect(phases[1].discounts).toBeUndefined();
  });
});
