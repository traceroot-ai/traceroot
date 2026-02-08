// Stripe client
export { stripe, getStripeOrThrow } from "./stripe.js";

// Plans and entitlements (single source of truth)
export {
  // Constants
  PLANS,
  ENTITLEMENTS,
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
} from "./plans.js";
