import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

const signatureHeader = { value: "t=1,v1=sig" as string | null };
vi.mock("next/headers", () => ({
  headers: async () => new Map([["stripe-signature", signatureHeader.value]]),
}));

// The plan item is looked up by the real helper, so the price env vars it reads
// must be in place before core's plan table is built.
vi.hoisted(() => {
  process.env.STRIPE_PRICE_ID_PRO = "price_pro";
  process.env.STRIPE_PRICE_ID_AI_USAGE = "price_ai_usage";
  process.env.STRIPE_PRICE_ID_RCA_USAGE = "price_rca_usage";
  process.env.STRIPE_PRICE_ID_DETECTOR_USAGE = "price_detector_usage";
});

const workspaceUpdateMock = vi.fn();
const workspaceUpdateManyMock = vi.fn();
const constructEventMock = vi.fn();
const subscriptionRetrieveMock = vi.fn();

vi.mock("@traceroot/core", async () => ({
  findPlanItem: (
    await vi.importActual<
      typeof import("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
    >("../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
  ).findPlanItem,
  prisma: {
    workspace: {
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
      updateMany: (...args: unknown[]) => workspaceUpdateManyMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    webhooks: { constructEvent: (...args: unknown[]) => constructEventMock(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => subscriptionRetrieveMock(...args) },
  }),
  mapPriceIdToPlan: (priceId: string | null) => (priceId === "price_pro" ? "pro" : "free"),
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
}));

import { POST } from "./route";

/** A Prisma P2025 — the error thrown when `update` targets a row that isn't there. */
function recordNotFound(): Error & { code: string } {
  const err = new Error(
    "An operation failed because it depends on one or more records that were required but not found. Record to update not found.",
  ) as Error & { code: string };
  err.code = "P2025";
  return err;
}

function subscriptionEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  workspaceId: string | undefined = "ws-gone",
  priceIds: string[] = ["price_pro"],
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    type,
    data: {
      object: {
        id: "sub_test123",
        customer: "cus_test123",
        status: "active",
        metadata: workspaceId ? { workspaceId } : {},
        current_period_start: now,
        current_period_end: now + 2_592_000,
        items: { data: priceIds.map((id) => ({ price: { id } })) },
      },
    },
  };
}

function makeRequest() {
  return { text: async () => "{}" } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  workspaceUpdateMock.mockReset();
  workspaceUpdateManyMock.mockReset();
  constructEventMock.mockReset();
  subscriptionRetrieveMock.mockReset();
  signatureHeader.value = "t=1,v1=sig";
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_test";
  // Default: the workspace exists.
  workspaceUpdateMock.mockResolvedValue({ id: "ws-1" });
  workspaceUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe("POST /api/billing/webhook — unknown workspace", () => {
  it("acknowledges a subscription update whose workspace no longer exists", async () => {
    constructEventMock.mockReturnValue(subscriptionEvent("customer.subscription.updated"));
    workspaceUpdateMock.mockRejectedValue(recordNotFound());
    workspaceUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest());

    // Stripe retries anything that isn't 2xx, and this event can never succeed —
    // the workspace is gone. Retrying until Stripe disables the endpoint takes
    // all billing sync down with it.
    expect(res.status).toBe(200);
  });

  it("acknowledges a subscription deletion whose workspace no longer exists", async () => {
    constructEventMock.mockReturnValue(subscriptionEvent("customer.subscription.deleted"));
    workspaceUpdateMock.mockRejectedValue(recordNotFound());
    workspaceUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
  });
});

describe("POST /api/billing/webhook — transient failures still retry", () => {
  it("returns 500 when the database is unreachable, so Stripe retries", async () => {
    constructEventMock.mockReturnValue(subscriptionEvent("customer.subscription.updated"));
    const dbDown = new Error("Can't reach database server at postgres:5432");
    workspaceUpdateMock.mockRejectedValue(dbDown);
    workspaceUpdateManyMock.mockRejectedValue(dbDown);

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
  });
});

describe("POST /api/billing/webhook — healthy path", () => {
  it("writes the workspace's plan and billing period, then acknowledges", async () => {
    constructEventMock.mockReturnValue(
      subscriptionEvent("customer.subscription.updated", "ws-live"),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const write = workspaceUpdateManyMock.mock.calls[0] ?? workspaceUpdateMock.mock.calls[0];
    expect(write).toBeDefined();
    const arg = write[0] as {
      where: { id: string };
      data: { billingPlan: string; billingSubscriptionId: string; billingPeriodEnd: Date };
    };
    expect(arg.where.id).toBe("ws-live");
    expect(arg.data.billingPlan).toBe("pro");
    expect(arg.data.billingSubscriptionId).toBe("sub_test123");
    expect(arg.data.billingPeriodEnd).toBeInstanceOf(Date);
  });

  it("keeps the paid plan when the plan item comes after the metered items", async () => {
    // A downgrade schedule's phase transition keeps the metered items and
    // recreates the plan item, which then lands last (#1880).
    constructEventMock.mockReturnValue(
      subscriptionEvent("customer.subscription.updated", "ws-live", [
        "price_ai_usage",
        "price_rca_usage",
        "price_detector_usage",
        "price_pro",
      ]),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const write = workspaceUpdateManyMock.mock.calls[0] ?? workspaceUpdateMock.mock.calls[0];
    const arg = write[0] as { data: { billingPlan: string; billingPriceId: string } };
    expect(arg.data.billingPlan).toBe("pro");
    expect(arg.data.billingPriceId).toBe("price_pro");
  });

  it("reverts the workspace to the free plan on subscription deletion", async () => {
    constructEventMock.mockReturnValue(
      subscriptionEvent("customer.subscription.deleted", "ws-live"),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const write = workspaceUpdateManyMock.mock.calls[0] ?? workspaceUpdateMock.mock.calls[0];
    expect(write).toBeDefined();
    const arg = write[0] as { data: { billingPlan: string; billingSubscriptionId: null } };
    expect(arg.data.billingPlan).toBe("free");
    expect(arg.data.billingSubscriptionId).toBeNull();
  });
});

describe("POST /api/billing/webhook — signature handling is unchanged", () => {
  it("rejects a request with no stripe-signature header", async () => {
    signatureHeader.value = null;

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
  });

  it("rejects a request whose signature does not verify", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
  });
});
