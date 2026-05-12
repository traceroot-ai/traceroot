// Stripe client
export { stripe, getStripeOrThrow } from "./stripe.js";

// Plans and entitlements (single source of truth)
export {
  // Constants
  PLANS,
  ENTITLEMENTS,
  SEAT_LIMITS,
  USAGE_CONFIG,
  EVENT_QUOTAS,
  AI_RUN_QUOTAS,
  RCA_RUN_QUOTAS,
  DETECTOR_RUN_QUOTAS,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD,
  PlanType,
  // Types
  type PlanConfig,
  type Entitlement,
  // Plan helpers
  getPlanConfig,
  getPlanOrder,
  mapPriceIdToPlan,
  isUpgrade,
  isDowngrade,
  // Entitlement helpers
  hasEntitlement,
  getEntitlements,
  requireEntitlement,
  // Seat enforcement
  getSeatLimit,
  canAddSeat,
  requireSeatAvailable,
  // Billing gate
  isBillingEnabled,
  // Free plan blocking
  isFreePlanBlocked,
  isAiRunBlocked,
  isRcaRunBlocked,
  isDetectorRunBlocked,
} from "./plans.js";
