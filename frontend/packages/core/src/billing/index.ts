// Stripe client
export { stripe, getStripeOrThrow } from "./stripe.js";

// Plans and entitlements (single source of truth)
export {
  // Constants
  PLANS,
  ENTITLEMENTS,
  SEAT_LIMITS,
  USAGE_CONFIG,
  USAGE_PRICE_ID,
  USAGE_PRICING_DESCRIPTION,
  FREE_PLAN_LIMIT,
  // Types
  type PlanType,
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
  // Free plan limit
  isFreePlanBlocked,
} from "./plans.js";
