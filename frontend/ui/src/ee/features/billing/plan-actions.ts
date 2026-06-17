// Plan-selection decision logic for the pricing dialog.
// Extracted from PricingDialog so the logic is unit-testable without rendering React.
import { PlanType, isUpgrade } from "@traceroot/core";

export type PlanAction =
  | { type: "none" }
  | { type: "contact-sales" }
  | { type: "checkout" }
  | { type: "change-plan" };

export function getPlanButtonText(currentPlan: PlanType, planId: PlanType): string {
  if (planId === currentPlan) return "Current Plan";
  if (planId === PlanType.ENTERPRISE) return "Contact Sales";
  if (planId === PlanType.FREE) return "Downgrade";
  if (isUpgrade(currentPlan, planId)) return "Upgrade";
  return "Downgrade";
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
