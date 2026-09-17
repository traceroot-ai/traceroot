import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
}));

// The plan item is looked up by the real helper, so the price env vars it reads
// must be in place before core's plan table is built.
vi.hoisted(() => {
  process.env.STRIPE_PRICE_ID_PRO = "price_pro";
  process.env.STRIPE_PRICE_ID_AI_USAGE = "price_ai_usage";
  process.env.STRIPE_PRICE_ID_RCA_USAGE = "price_rca_usage";
  process.env.STRIPE_PRICE_ID_DETECTOR_USAGE = "price_detector_usage";
});

const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionMock(...args) } },
}));

const workspaceFindFirstMock = vi.fn();
const workspaceUpdateMock = vi.fn();
const sessionsRetrieveMock = vi.fn();
const subscriptionsRetrieveMock = vi.fn();

vi.mock("@traceroot/core", async () => ({
  findPlanItem: (
    await vi.importActual<
      typeof import("../../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
    >("../../../../../../../packages/core/src/ee/billing/subscriptionItems.ts")
  ).findPlanItem,
  mapPriceIdToPlan: (priceId: string | null) => (priceId === "price_pro" ? "pro" : "free"),
  prisma: {
    workspace: {
      findFirst: (...args: unknown[]) => workspaceFindFirstMock(...args),
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    checkout: { sessions: { retrieve: (...args: unknown[]) => sessionsRetrieveMock(...args) } },
    subscriptions: { retrieve: (...args: unknown[]) => subscriptionsRetrieveMock(...args) },
  }),
}));

import { POST } from "./route";

const now = Math.floor(Date.now() / 1000);

function subscription(workspaceId = "ws-1") {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { workspaceId },
    current_period_start: now,
    current_period_end: now + 2_592_000,
    items: {
      data: ["price_ai_usage", "price_rca_usage", "price_detector_usage", "price_pro"].map(
        (id) => ({
          price: { id },
        }),
      ),
    },
  };
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    status: "complete",
    metadata: { workspaceId: "ws-1" },
    subscription: subscription(),
    ...overrides,
  };
}

function makeRequest(body: unknown = { workspaceId: "ws-1", sessionId: "cs_1" }) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  getSessionMock.mockReset();
  workspaceFindFirstMock.mockReset();
  workspaceUpdateMock.mockReset();
  sessionsRetrieveMock.mockReset();
  subscriptionsRetrieveMock.mockReset();

  getSessionMock.mockResolvedValue({ user: { id: "user-1" } });
  workspaceFindFirstMock.mockResolvedValue({ id: "ws-1" });
  workspaceUpdateMock.mockResolvedValue({ id: "ws-1" });
  sessionsRetrieveMock.mockResolvedValue(checkoutSession());
});

describe("POST /api/billing/checkout/reconcile", () => {
  it("writes the subscription's billing state for a completed checkout", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reconciled: true, plan: "pro" });
    expect(workspaceUpdateMock).toHaveBeenCalledTimes(1);
    const arg = workspaceUpdateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where.id).toBe("ws-1");
    expect(arg.data).toMatchObject({
      billingCustomerId: "cus_1",
      billingSubscriptionId: "sub_1",
      billingPriceId: "price_pro",
      billingStatus: "active",
      billingPlan: "pro",
    });
    expect(arg.data.billingPeriodEnd).toBeInstanceOf(Date);
  });

  it("retrieves the subscription when the session returns only its id", async () => {
    sessionsRetrieveMock.mockResolvedValue(checkoutSession({ subscription: "sub_1" }));
    subscriptionsRetrieveMock.mockResolvedValue(subscription());

    const res = await POST(makeRequest());

    expect(await res.json()).toEqual({ reconciled: true, plan: "pro" });
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith("sub_1");
  });

  it("does not write while the checkout is still open", async () => {
    sessionsRetrieveMock.mockResolvedValue(checkoutSession({ status: "open", subscription: null }));

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reconciled: false });
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses a checkout session that belongs to another workspace", async () => {
    sessionsRetrieveMock.mockResolvedValue(
      checkoutSession({ metadata: { workspaceId: "ws-other" } }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(404);
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses a subscription that belongs to another workspace", async () => {
    sessionsRetrieveMock.mockResolvedValue(
      checkoutSession({ subscription: subscription("ws-other") }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(404);
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses a user who is not an admin of the workspace", async () => {
    workspaceFindFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(404);
    expect(sessionsRetrieveMock).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
  });

  it("requires a session id", async () => {
    const res = await POST(makeRequest({ workspaceId: "ws-1" }));

    expect(res.status).toBe(400);
    expect(sessionsRetrieveMock).not.toHaveBeenCalled();
  });
});
