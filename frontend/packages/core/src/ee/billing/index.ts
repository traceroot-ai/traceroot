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
} from "./plans.js";
