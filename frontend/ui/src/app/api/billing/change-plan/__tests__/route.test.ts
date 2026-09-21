import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

const mockGetSession = vi.fn();
const mockWorkspaceFindFirst = vi.fn();
const mockWorkspaceUpdate = vi.fn();

const stripe = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  subscriptionSchedules: { release: vi.fn(), create: vi.fn(), update: vi.fn() },
};

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      workspace: {
        findFirst: (...a: unknown[]) => mockWorkspaceFindFirst(...a),
        update: (...a: unknown[]) => mockWorkspaceUpdate(...a),
      },
    },
    getStripeOrThrow: () => stripe,
  };
});

const routePath = path.join(__dirname, "..", "route.ts");
const PERIOD_END = 1_800_000_000;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    schedule: null,
    cancel_at_period_end: false,
    current_period_end: PERIOD_END,
    items: { data: [{ id: "si_plan", price: { id: "price_plan" }, quantity: 1 }] },
    ...overrides,
  };
}

async function changePlan(billingPlan: string, newPlan: string, billingSubscriptionId = "sub_1") {
  mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1", billingPlan, billingSubscriptionId });
  const mod = await import(pathToFileURL(routePath).href);
  const res = await mod.POST({ json: async () => ({ workspaceId: "ws-1", newPlan }) });
  return { status: res.status, body: await res.json() };
}

describe("change-plan route", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetSession.mockResolvedValue({ user: { id: "u-1" } });
    stripe.subscriptions.retrieve.mockResolvedValue(subscription());
    stripe.subscriptions.update.mockResolvedValue({
      id: "sub_1",
      status: "active",
      items: { data: [{ price: { id: "price_new" } }] },
    });
    stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sched_1",
      phases: [{ start_date: 1 }],
    });
    mockWorkspaceUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("recognized plans behave exactly as before", () => {
    it("moving to a higher plan changes the subscription immediately", async () => {
      const { body } = await changePlan("starter", "pro");
      expect(body.message).toBe("Upgraded immediately");
      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_1",
        expect.objectContaining({ proration_behavior: "always_invoice" }),
      );
      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    });

    it("moving to a lower paid plan schedules the change for period end", async () => {
      const { body } = await changePlan("pro", "starter");
      expect(body.message).toBe("Downgrade scheduled for next billing period");
      expect(stripe.subscriptionSchedules.create).toHaveBeenCalled();
      expect(stripe.subscriptions.update).not.toHaveBeenCalledWith(
        "sub_1",
        expect.objectContaining({ proration_behavior: "always_invoice" }),
      );
    });

    it("moving to free cancels at period end", async () => {
      const { body } = await changePlan("pro", "free");
      expect(body.message).toBe("Subscription will be canceled at period end");
      expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
        cancel_at_period_end: true,
      });
    });

    it("re-requesting the plan already stored is a no-op", async () => {
      const { body } = await changePlan("pro", "pro");
      expect(body.message).toBe("Already on this plan");
      expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    });
  });

  describe("unrecognized stored plan", () => {
    // billingPlan is free-form TEXT. Casting it left getPlanOrder undefined, so
    // isUpgrade was false for every target and a move up landed in the
    // downgrade branch — scheduled for period end instead of applied now.
    it("is ordered as free, so a paid target is applied immediately", async () => {
      const { body } = await changePlan("legacy-team", "pro");
      expect(body.message).toBe("Upgraded immediately");
      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_1",
        expect.objectContaining({ proration_behavior: "always_invoice" }),
      );
      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    });

    // The same-plan short-circuit compares the *stored* value, not the narrowed
    // one. A workspace with an unrecognized plan can still hold a live paid
    // subscription; narrowing it to free here would answer "already on this
    // plan" and silently leave that subscription running.
    it("can still cancel a live subscription by moving to free", async () => {
      const { body } = await changePlan("legacy-team", "free");
      expect(body.message).toBe("Subscription will be canceled at period end");
      expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
        cancel_at_period_end: true,
      });
    });
  });
});
