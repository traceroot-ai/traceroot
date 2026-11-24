// Plan-selection decision logic for the pricing dialog.
// Extracted from PricingDialog so the logic is unit-testable without rendering React.
import { PlanType, isUpgrade } from "@traceroot/core";
import type { Translate } from "@/lib/i18n/translate";

export type PlanAction =
  | { type: "none" }
  | { type: "contact-sales" }
  | { type: "checkout" }
  | { type: "change-plan" };

/** `t` puts the label in the visitor's language; without it the label is English. */
export function getPlanButtonText(currentPlan: PlanType, planId: PlanType, t?: Translate): string {
  if (planId === currentPlan) return t ? t("billing.currentPlanButton") : "Current Plan";
  if (planId === PlanType.ENTERPRISE) return t ? t("billing.contactSales") : "Contact Sales";
  if (planId === PlanType.FREE) return t ? t("billing.downgrade") : "Downgrade";
  if (isUpgrade(currentPlan, planId)) return t ? t("billing.upgrade") : "Upgrade";
  return t ? t("billing.downgrade") : "Downgrade";
}

export function resolvePlanAction(
  currentPlan: PlanType,
  newPlan: PlanType,
  hasSubscription: boolean,
): PlanAction {
  if (newPlan === currentPlan) return { type: "none" };

  // Enterprise = contact sales
  if (newPlan === PlanType.ENTERPRISE) return { type: "contact-sales" };

  // No subscription yet, need to go through checkout
  if (!hasSubscription && newPlan !== PlanType.FREE) return { type: "checkout" };

  // Has subscription, use change-plan (upgrade, downgrade, or cancel to free)
  return { type: "change-plan" };
}
