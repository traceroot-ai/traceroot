import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const getSessionMock = vi.fn();
vi.mock("@/lib/request-session", () => ({
  getRequestSession: (...args: unknown[]) => getSessionMock(...args),
}));

const workspaceFindFirstMock = vi.fn();
const workspaceUpdateMock = vi.fn();
const subscriptionsListMock = vi.fn();
const customersCreateMock = vi.fn();
const checkoutCreateMock = vi.fn();

// Like Stripe's list result: `data` is only the first page (limit 100), and
// iterating the result follows every page.
function stripeList<T>(items: T[]) {
  return {
    data: items.slice(0, 100),
    has_more: items.length > 100,
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findFirst: (...args: unknown[]) => workspaceFindFirstMock(...args),
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    subscriptions: {
      list: (...args: unknown[]) => stripeList(subscriptionsListMock(...args)),
    },
    customers: {
      create: (...args: unknown[]) => customersCreateMock(...args),
    },
    checkout: {
      sessions: {
        create: (...args: unknown[]) => checkoutCreateMock(...args),
      },
    },
  }),
  getPlanConfig: () => ({ billingPriceId: "price_pro" }),
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  METERED_PRICE_ENV_VARS: [],
}));

import { POST } from "./route";

function makeRequest(body: unknown = { workspaceId: "ws-1", plan: "pro" }) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function workspace(overrides: Record<string, unknown> = {}) {
  return { id: "ws-1", billingCustomerId: "cus_1", billingSubscriptionId: null, ...overrides };
}

beforeEach(() => {
  getSessionMock.mockReset();
  workspaceFindFirstMock.mockReset();
  workspaceUpdateMock.mockReset();
  subscriptionsListMock.mockReset();
  customersCreateMock.mockReset();
  checkoutCreateMock.mockReset();

  // better-auth's shape: the route is wrapped in withImpersonationPolicy, which
  // reads session.session to decide whether this is a staff impersonation.
  getSessionMock.mockResolvedValue({
    user: { id: "user-1", email: "a@example.com" },
    session: { id: "session-1" },
  });
  subscriptionsListMock.mockReturnValue([]);
  checkoutCreateMock.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
  workspaceUpdateMock.mockResolvedValue({});
});

describe("POST /api/billing/checkout — existing subscription", () => {
  it("refuses a workspace that already has a stored subscription", async () => {
    workspaceFindFirstMock.mockResolvedValue(
      workspace({ billingCustomerId: null, billingSubscriptionId: "sub_1" }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it("lets Stripe decide when the row still names a subscription that has ended", async () => {
    // The cancellation webhook was missed, so the row still carries the id.
    workspaceFindFirstMock.mockResolvedValue(workspace({ billingSubscriptionId: "sub_old" }));
    subscriptionsListMock.mockReturnValue([{ id: "sub_old", status: "canceled" }]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when Stripe has a live subscription the workspace row has not caught up with", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    subscriptionsListMock.mockReturnValue([{ id: "sub_1", status: "active" }]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(subscriptionsListMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1" }),
    );
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "paused"])("refuses while a subscription is %s", async (status) => {
    // Neither status bills right now, but neither is terminal: the first settles into
    // active and the second can be resumed, so a second checkout would bill twice.
    workspaceFindFirstMock.mockResolvedValue(workspace());
    subscriptionsListMock.mockReturnValue([{ id: "sub_1", status }]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it("finds a live subscription on a later page, past the first 100", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    subscriptionsListMock.mockReturnValue([
      ...Array.from({ length: 150 }, (_, i) => ({ id: `sub_old_${i}`, status: "canceled" })),
      { id: "sub_live", status: "active" },
    ]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it("opens checkout when the customer's only subscriptions have ended", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    subscriptionsListMock.mockReturnValue([
      { id: "sub_old", status: "canceled" },
      { id: "sub_abandoned", status: "incomplete_expired" },
    ]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
  });

  it("opens checkout for a workspace that has never been a Stripe customer", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace({ billingCustomerId: null }));
    customersCreateMock.mockResolvedValue({ id: "cus_new" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(workspaceUpdateMock).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { billingCustomerId: "cus_new" },
    });
    // A new customer has no subscriptions to list.
    expect(subscriptionsListMock).not.toHaveBeenCalled();
    expect(checkoutCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
    );
  });
});
