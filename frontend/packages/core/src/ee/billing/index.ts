// Stripe client
export { stripe, getStripeOrThrow } from "./stripe";

// Plans and entitlements (single source of truth)
export {
  // Constants
  PLANS,
  ENTITLEMENTS,
  SEAT_LIMITS,
  USAGE_CONFIG,
  SPAN_QUOTAS,
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
  // Free plan blocking
  isFreePlanBlocked,
} from "./plans";
