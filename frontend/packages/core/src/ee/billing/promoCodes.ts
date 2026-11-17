import type Stripe from "stripe";

/**
 * Promo codes are Stripe promotion codes. Stripe owns the discount math; this
 * module only decides whether a code may be used for a given plan.
 *
 * A coupon is tied to a plan with `metadata.plan` (e.g. "pro"). We do not use
 * the coupon's `applies_to`: it restricts by product, and every paid
 * subscription also carries the metered products, so it cannot both restrict
 * the plan and discount the metered items. A coupon without `metadata.plan`
 * is refused (fail closed).
 */

export type PromoFailureReason = "invalid" | "expired" | "wrong_plan";

export type PromoResolution =
  | { ok: true; promotionCodeId: string }
  | { ok: false; reason: PromoFailureReason; message: string };

export type PromoStripe = { promotionCodes: Pick<Stripe.PromotionCodesResource, "list"> };

const MAX_CODE_LENGTH = 64;

export const PROMO_MESSAGES: Record<PromoFailureReason, string> = {
  invalid: "This promo code is not valid.",
  expired: "This promo code has expired.",
  wrong_plan: "This promo code is not valid for the selected plan.",
};

export function normalizePromoCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim();
  if (!code || code.length > MAX_CODE_LENGTH) return null;
  return code;
}

function fail(reason: PromoFailureReason): PromoResolution {
  return { ok: false, reason, message: PROMO_MESSAGES[reason] };
}

function planOf(coupon: { metadata?: Record<string, string> | null }): string | null {
  const plan = coupon.metadata?.plan;
  return plan ? plan.toLowerCase() : null;
}

/** Look the code up in Stripe and check it can be used for `plan`. Creates nothing. */
export async function resolvePromoForPlan(
  stripe: PromoStripe,
  code: string,
  plan: string,
  now: number = Date.now(),
): Promise<PromoResolution> {
  const { data } = await stripe.promotionCodes.list({
    code,
    limit: 10,
    expand: ["data.coupon"],
  });

  // Codes are unique among active ones; archived ones may share the string.
  const promo = data.find((p) => p.active) ?? data[0];
  if (!promo) return fail("invalid");

  const expired = promo.expires_at != null && promo.expires_at * 1000 <= now;
  if (expired) return fail("expired");
  if (!promo.active || !promo.coupon.valid) return fail("invalid");

  if (planOf(promo.coupon) !== plan.toLowerCase()) return fail("wrong_plan");

  return { ok: true, promotionCodeId: promo.id };
}

/**
 * Ids of the subscription's discounts that may stay when it moves to `newPlan`.
 * A discount whose coupon is tied to another plan ends; one with no plan tag
 * (e.g. applied by hand in the Stripe Dashboard) is left alone.
 */
export function discountsToKeepForPlan(
  discounts: { id: string; coupon: { metadata?: Record<string, string> | null } }[],
  newPlan: string,
): string[] {
  return discounts
    .filter((d) => {
      const plan = planOf(d.coupon);
      return plan === null || plan === newPlan.toLowerCase();
    })
    .map((d) => d.id);
}
