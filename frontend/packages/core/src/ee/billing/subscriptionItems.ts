import { PLANS } from "./plans.ts";

/**
 * Env vars holding the metered usage prices that ride on every paid subscription
 * next to the plan price (see the checkout route, which adds all three).
 */
export const METERED_PRICE_ENV_VARS = [
  "STRIPE_PRICE_ID_AI_USAGE",
  "STRIPE_PRICE_ID_RCA_USAGE",
  "STRIPE_PRICE_ID_DETECTOR_USAGE",
] as const;

export function getMeteredPriceIds(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set(
    METERED_PRICE_ENV_VARS.map((name) => env[name]).filter((id): id is string => Boolean(id)),
  );
}

function isPlanPriceId(priceId: string): boolean {
  return Object.values(PLANS).some(
    (plan) => plan.billingPriceId !== "" && plan.billingPriceId === priceId,
  );
}

/**
 * The subscription item that carries the plan price.
 *
 * Item order cannot be relied on. When a subscription schedule moves to its next
 * phase (the downgrade path in change-plan), Stripe keeps the metered items and
 * recreates the plan item, which then comes last. Reading `items.data[0]` there
 * returns a metered price and maps the workspace to the free plan.
 *
 * An item whose price is a configured plan price wins. Otherwise the first item
 * that is not a known metered price is returned, which is what the callers did
 * before and still finds the plan item when a plan price env var is not set.
 */
export function findPlanItem<T extends { price: { id: string } }>(
  items: readonly T[],
  meteredPriceIds: ReadonlySet<string> = getMeteredPriceIds(),
): T | undefined {
  const candidates = items.filter((item) => !meteredPriceIds.has(item.price.id));
  return candidates.find((item) => isPlanPriceId(item.price.id)) ?? candidates[0];
}
