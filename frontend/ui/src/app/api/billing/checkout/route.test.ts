import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
}));

const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionMock(...args) } },
}));

const workspaceFindFirstMock = vi.fn();
const workspaceUpdateMock = vi.fn();
const subscriptionsListMock = vi.fn();
const customersCreateMock = vi.fn();
const checkoutCreateMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findFirst: (...args: unknown[]) => workspaceFindFirstMock(...args),
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    subscriptions: {
      // Stripe's list result is async-iterable across pages; the mock returns the
      // full sequence of subscriptions.
      list: (...args: unknown[]) => {
        const subscriptions = subscriptionsListMock(...args) as Array<{ status: string }>;
        return {
          async *[Symbol.asyncIterator]() {
            yield* subscriptions;
          },
        };
      },
    },
    customers: { create: (...args: unknown[]) => customersCreateMock(...args) },
    checkout: { sessions: { create: (...args: unknown[]) => checkoutCreateMock(...args) } },
  }),
  getPlanConfig: () => ({ billingPriceId: "price_pro" }),
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
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

  getSessionMock.mockResolvedValue({ user: { id: "user-1", email: "a@example.com" } });
  subscriptionsListMock.mockReturnValue([]);
  checkoutCreateMock.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
});

describe("POST /api/billing/checkout — existing subscription", () => {
  it("refuses a workspace that already has a stored subscription", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace({ billingSubscriptionId: "sub_1" }));

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(checkoutCreateMock).not.toHaveBeenCalled();
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

  it("refuses while a first payment is still settling", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    subscriptionsListMock.mockReturnValue([{ id: "sub_pending", status: "incomplete" }]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it("finds a live subscription behind a full page of ended ones", async () => {
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
    expect(subscriptionsListMock).not.toHaveBeenCalled();
    expect(checkoutCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
    );
  });
});
