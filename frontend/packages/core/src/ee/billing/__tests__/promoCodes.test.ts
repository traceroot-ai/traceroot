import { describe, it, expect, vi } from "vitest";
import {
  resolvePromoForPlan,
  discountsToKeepForPlan,
  normalizePromoCode,
  type PromoStripe,
} from "../promoCodes.ts";

const NOW = 1_800_000_000_000;

function promo(
  overrides: Record<string, unknown> = {},
  couponMeta: Record<string, string> = { plan: "pro" },
) {
  return {
    id: "promo_1",
    code: "LAUNCH",
    active: true,
    expires_at: null,
    coupon: { id: "coupon_1", valid: true, metadata: couponMeta },
    ...overrides,
  };
}

function stripeWith(data: unknown[]) {
  const list = vi.fn().mockResolvedValue({ data });
  return { stripe: { promotionCodes: { list } } as unknown as PromoStripe, list };
}

describe("normalizePromoCode", () => {
  it("trims and rejects empty or oversized input", () => {
    expect(normalizePromoCode("  LAUNCH ")).toBe("LAUNCH");
    expect(normalizePromoCode("   ")).toBeNull();
    expect(normalizePromoCode(undefined)).toBeNull();
    expect(normalizePromoCode(42)).toBeNull();
    expect(normalizePromoCode("x".repeat(65))).toBeNull();
  });
});

describe("resolvePromoForPlan", () => {
  it("accepts a valid code on the plan named in the coupon metadata", async () => {
    const { stripe, list } = stripeWith([promo()]);
    const r = await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW);
    expect(r).toEqual({ ok: true, promotionCodeId: "promo_1" });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LAUNCH", expand: ["data.coupon"] }),
    );
  });

  it("matches the plan case-insensitively", async () => {
    const { stripe } = stripeWith([promo({}, { plan: "PRO" })]);
    expect((await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).ok).toBe(true);
  });

  it("rejects a code made for another plan", async () => {
    const { stripe } = stripeWith([promo({}, { plan: "starter" })]);
    expect(await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).toMatchObject({
      ok: false,
      reason: "wrong_plan",
    });
  });

  it("fails closed when the coupon has no plan metadata", async () => {
    const { stripe } = stripeWith([promo({}, {})]);
    expect(await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).toMatchObject({
      ok: false,
      reason: "wrong_plan",
    });
  });

  it("rejects an unknown code", async () => {
    const { stripe } = stripeWith([]);
    expect(await resolvePromoForPlan(stripe, "NOPE", "pro", NOW)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports an expired code (past expires_at, now inactive)", async () => {
    const { stripe } = stripeWith([
      promo({ active: false, expires_at: Math.floor(NOW / 1000) - 60 }),
    ]);
    expect(await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("reports an expired code even if Stripe still says active", async () => {
    const { stripe } = stripeWith([promo({ expires_at: Math.floor(NOW / 1000) - 1 })]);
    expect(await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("treats an archived code or an invalid coupon as invalid", async () => {
    expect(
      await resolvePromoForPlan(
        stripeWith([promo({ active: false })]).stripe,
        "LAUNCH",
        "pro",
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    const dead = promo();
    dead.coupon.valid = false;
    expect(
      await resolvePromoForPlan(stripeWith([dead]).stripe, "LAUNCH", "pro", NOW),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("prefers the active code when an archived one shares the string", async () => {
    const { stripe } = stripeWith([promo({ id: "old", active: false }), promo({ id: "new" })]);
    expect(await resolvePromoForPlan(stripe, "LAUNCH", "pro", NOW)).toEqual({
      ok: true,
      promotionCodeId: "new",
    });
  });
});

describe("discountsToKeepForPlan", () => {
  const d = (id: string, meta?: Record<string, string>) => ({
    id,
    coupon: { metadata: meta ?? {} },
  });

  it("drops plan-bound discounts that belong to another plan and keeps the rest", () => {
    const kept = discountsToKeepForPlan(
      [d("di_pro", { plan: "pro" }), d("di_starter", { plan: "starter" }), d("di_manual")],
      "pro",
    );
    expect(kept).toEqual(["di_pro", "di_manual"]);
  });

  it("returns an empty list when nothing applies", () => {
    expect(discountsToKeepForPlan([d("di_starter", { plan: "starter" })], "pro")).toEqual([]);
    expect(discountsToKeepForPlan([], "pro")).toEqual([]);
  });
});
