// Stripe client
export { stripe, getStripeOrThrow } from "./stripe.ts";

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
  countCurrentSeats,
  getSeatLimit,
  canAddSeat,
  requireSeatAvailable,
  // Billing gate
  isBillingEnabled,
  // Free plan blocking
  isFreePlanBlocked,
  isIngestionBlocked,
  isAiRunBlocked,
  isRcaRunBlocked,
  isDetectorRunBlocked,
} from "./plans.ts";

// Free-plan usage-quota notification decision (pure helper + types)
export {
  USAGE_WARNING_RATIO,
  decideUsageNotification,
  type UsageMeter,
  type UsageNotificationState,
  type UsageNotificationDecision,
} from "./usageNotifications.ts";
