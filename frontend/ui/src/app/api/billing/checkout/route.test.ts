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
const checkoutListMock = vi.fn();
const checkoutExpireMock = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findFirst: (...args: unknown[]) => workspaceFindFirstMock(...args),
      update: (...args: unknown[]) => workspaceUpdateMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    subscriptions: {
      // Like Stripe's list result: `data` is only the first page (limit 100), and
      // iterating the result follows every page.
      list: (...args: unknown[]) => {
        const subscriptions = subscriptionsListMock(...args) as Array<{ status: string }>;
        return {
          data: subscriptions.slice(0, 100),
          has_more: subscriptions.length > 100,
          async *[Symbol.asyncIterator]() {
            yield* subscriptions;
          },
        };
      },
    },
    customers: { create: (...args: unknown[]) => customersCreateMock(...args) },
    checkout: {
      sessions: {
        create: (...args: unknown[]) => checkoutCreateMock(...args),
        list: (...args: unknown[]) => checkoutListMock(...args),
        expire: (...args: unknown[]) => checkoutExpireMock(...args),
      },
    },
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
  checkoutListMock.mockReset();
  checkoutExpireMock.mockReset();

  getSessionMock.mockResolvedValue({ user: { id: "user-1", email: "a@example.com" } });
  subscriptionsListMock.mockReturnValue([]);
  checkoutCreateMock.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
  checkoutListMock.mockResolvedValue({ data: [] });
  checkoutExpireMock.mockResolvedValue({});
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

  it("hands back a checkout already open for the same plan instead of opening another", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockResolvedValue({
      data: [
        {
          id: "cs_open",
          url: "https://checkout.stripe.test/open",
          metadata: { workspaceId: "ws-1", plan: "pro" },
        },
      ],
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/open" });
    expect(checkoutCreateMock).not.toHaveBeenCalled();
    expect(checkoutExpireMock).not.toHaveBeenCalled();
  });

  it("expires an open checkout for a different plan before opening the new one", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockResolvedValue({
      data: [
        {
          id: "cs_starter",
          url: "https://checkout.stripe.test/starter",
          metadata: { workspaceId: "ws-1", plan: "starter" },
        },
      ],
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(checkoutExpireMock).toHaveBeenCalledWith("cs_starter");
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
  });

  it("gives simultaneous requests the same idempotency key, so Stripe opens one session", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    // Pin the clock so the two requests cannot straddle an idempotency window.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);

    await Promise.all([POST(makeRequest()), POST(makeRequest())]);
    now.mockRestore();

    expect(checkoutCreateMock).toHaveBeenCalledTimes(2);
    const [[params, first], [, second]] = checkoutCreateMock.mock.calls as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ][];
    expect(first.idempotencyKey).toMatch(/^workspace-checkout-ws-1-pro-/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(params).toMatchObject({ metadata: { workspaceId: "ws-1", plan: "pro" } });
  });

  it("opens checkout for a workspace that has never been a Stripe customer", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace({ billingCustomerId: null }));
    customersCreateMock.mockResolvedValue({ id: "cus_new" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(subscriptionsListMock).not.toHaveBeenCalled();
    expect(checkoutCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });
});
