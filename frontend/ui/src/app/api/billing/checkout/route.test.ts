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
const workspaceUpdateManyMock = vi.fn();
const workspaceFindUniqueMock = vi.fn();
const subscriptionsListMock = vi.fn();
const customersCreateMock = vi.fn();
const customersDelMock = vi.fn();
const checkoutCreateMock = vi.fn();
const checkoutListMock = vi.fn();
const checkoutExpireMock = vi.fn();
const checkoutRetrieveMock = vi.fn();

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
      updateMany: (...args: unknown[]) => workspaceUpdateManyMock(...args),
      findUnique: (...args: unknown[]) => workspaceFindUniqueMock(...args),
    },
  },
  getStripeOrThrow: () => ({
    subscriptions: {
      list: (...args: unknown[]) => stripeList(subscriptionsListMock(...args)),
    },
    customers: {
      create: (...args: unknown[]) => customersCreateMock(...args),
      del: (...args: unknown[]) => customersDelMock(...args),
    },
    checkout: {
      sessions: {
        create: (...args: unknown[]) => checkoutCreateMock(...args),
        list: (...args: unknown[]) => stripeList(checkoutListMock(...args)),
        expire: (...args: unknown[]) => checkoutExpireMock(...args),
        retrieve: (...args: unknown[]) => checkoutRetrieveMock(...args),
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

function openSession(id: string, plan: string, workspaceId = "ws-1") {
  return { id, url: `https://checkout.stripe.test/${id}`, metadata: { workspaceId, plan } };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return { id: "ws-1", billingCustomerId: "cus_1", billingSubscriptionId: null, ...overrides };
}

beforeEach(() => {
  getSessionMock.mockReset();
  workspaceFindFirstMock.mockReset();
  workspaceUpdateManyMock.mockReset();
  workspaceFindUniqueMock.mockReset();
  subscriptionsListMock.mockReset();
  customersCreateMock.mockReset();
  customersDelMock.mockReset();
  checkoutCreateMock.mockReset();
  checkoutListMock.mockReset();
  checkoutExpireMock.mockReset();
  checkoutRetrieveMock.mockReset();

  getSessionMock.mockResolvedValue({ user: { id: "user-1", email: "a@example.com" } });
  subscriptionsListMock.mockReturnValue([]);
  checkoutCreateMock.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
  checkoutListMock.mockReturnValue([]);
  checkoutExpireMock.mockResolvedValue({});
  workspaceUpdateManyMock.mockResolvedValue({ count: 1 });
  customersDelMock.mockResolvedValue({});
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
    checkoutListMock.mockReturnValue([openSession("cs_open", "pro")]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/cs_open" });
    expect(checkoutCreateMock).not.toHaveBeenCalled();
    expect(checkoutExpireMock).not.toHaveBeenCalled();
  });

  it("expires an open checkout for a different plan before opening the new one", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockReturnValue([openSession("cs_starter", "starter")]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(checkoutExpireMock).toHaveBeenCalledWith("cs_starter");
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
  });

  it("finds an open checkout past the first page of sessions", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockReturnValue([
      ...Array.from({ length: 120 }, (_, i) =>
        openSession(`cs_other_${i}`, "pro", `ws-other-${i}`),
      ),
      openSession("cs_open", "pro"),
    ]);

    const res = await POST(makeRequest());

    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/cs_open" });
    expect(checkoutCreateMock).not.toHaveBeenCalled();
  });

  it("keeps one open checkout for the plan and expires any duplicates", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockReturnValue([
      openSession("cs_first", "pro"),
      openSession("cs_second", "pro"),
    ]);

    const res = await POST(makeRequest());

    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/cs_first" });
    expect(checkoutExpireMock).toHaveBeenCalledTimes(1);
    expect(checkoutExpireMock).toHaveBeenCalledWith("cs_second");
  });

  it("tolerates a session a simultaneous request already expired", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    checkoutListMock.mockReturnValue([openSession("cs_starter", "starter")]);
    checkoutExpireMock.mockRejectedValue(new Error("session is not open"));
    checkoutRetrieveMock.mockResolvedValue({ id: "cs_starter", status: "expired" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
  });

  it("uses a new idempotency key after expiring a session, so a retry is not served a closed one", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace());
    const now = vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);

    await POST(makeRequest());
    checkoutListMock.mockReturnValue([openSession("cs_starter", "starter")]);
    await POST(makeRequest());
    now.mockRestore();

    const [[, before], [, after]] = checkoutCreateMock.mock.calls as [
      unknown,
      { idempotencyKey: string },
    ][];
    expect(after.idempotencyKey).not.toBe(before.idempotencyKey);
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
    expect(workspaceUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "ws-1", billingCustomerId: null },
      data: { billingCustomerId: "cus_new" },
    });
  });

  it("continues with the stored customer when another admin created one first", async () => {
    workspaceFindFirstMock.mockResolvedValue(workspace({ billingCustomerId: null }));
    customersCreateMock.mockResolvedValue({ id: "cus_late" });
    workspaceUpdateManyMock.mockResolvedValue({ count: 0 });
    workspaceFindUniqueMock.mockResolvedValue({ billingCustomerId: "cus_first" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(customersDelMock).toHaveBeenCalledWith("cus_late");
    expect(checkoutCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_first" }),
      expect.anything(),
    );
  });
});
