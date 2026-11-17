/**
 * Promo codes are Stripe promotion codes entered on Stripe's hosted Checkout page.
 * Stripe owns the discount math and enforces which plan a code may be used for: each
 * coupon is created with `applies_to.products` set to its plan's product, so the code
 * is refused on any other plan's checkout.
 *
 * Coupons also carry `metadata.plan` ("starter" | "pro"). That tag is only used when a
 * subscription changes plan, to end a discount that belongs to the plan being left.
 */

function planOf(coupon: { metadata?: Record<string, string> | null }): string | null {
  const plan = coupon.metadata?.plan;
  return plan ? plan.toLowerCase() : null;
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
