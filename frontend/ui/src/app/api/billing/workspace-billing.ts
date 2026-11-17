import type Stripe from "stripe";
import { findPlanItem, mapPriceIdToPlan } from "@traceroot/core";

/**
 * The workspace billing columns derived from a Stripe subscription.
 *
 * The subscription webhook and the checkout reconcile both write these, so they
 * share one mapping and cannot disagree about what a subscription means.
 */
export function workspaceBillingFromSubscription(subscription: Stripe.Subscription) {
  const priceId = findPlanItem(subscription.items.data)?.price.id ?? null;
  return {
    billingCustomerId:
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    billingSubscriptionId: subscription.id,
    billingPriceId: priceId,
    billingStatus: subscription.status, // active, past_due, canceled, etc.
    billingPlan: mapPriceIdToPlan(priceId),
    // Current billing period (updated each month when the subscription renews)
    billingPeriodStart: new Date(subscription.current_period_start * 1000),
    billingPeriodEnd: new Date(subscription.current_period_end * 1000),
  };
}
