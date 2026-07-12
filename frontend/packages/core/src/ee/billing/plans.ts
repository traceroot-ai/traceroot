import { isBillingEnabled } from "../license.ts";
export { isBillingEnabled };

// =============================================================================
// PLAN TYPES
// =============================================================================
export const PlanType = {
  FREE: "free",
  STARTER: "starter",
  PRO: "pro",
  ENTERPRISE: "enterprise",
} as const;
export type PlanType = (typeof PlanType)[keyof typeof PlanType];

// =============================================================================
// USAGE QUOTAS
// =============================================================================
// Spans (observability)
export const EVENT_QUOTAS: Record<PlanType, { included: number; overageLabel: string }> = {
  [PlanType.FREE]: { included: 50_000, overageLabel: "Hard cap (upgrade to continue)" },
  [PlanType.STARTER]: { included: 150_000, overageLabel: "$4 per 50k events" },
  [PlanType.PRO]: { included: 150_000, overageLabel: "$4 per 50k events" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Custom" },
};

// AI runs
export const AI_RUN_QUOTAS: Record<PlanType, { included: number; overageLabel: string }> = {
  [PlanType.FREE]: { included: 30, overageLabel: "Hard cap (upgrade to continue)" },
  [PlanType.STARTER]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.PRO]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Unlimited" },
};

// RCA runs (auto-triggered by detector findings) — separate meter, same shape as AI runs
export const RCA_RUN_QUOTAS: Record<PlanType, { included: number; overageLabel: string }> = {
  [PlanType.FREE]: { included: 30, overageLabel: "Hard cap (upgrade to continue)" },
  [PlanType.STARTER]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.PRO]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Unlimited" },
};

// Detector runs (BYOK + hosted combined). Free has a hard cap so the
// "Free is truly free" promise holds — we absorb hosted-LLM cost up to the
// cap as customer-acquisition spend. Paid plans are unlimited; hosted
// inference is billed via STRIPE_PRICE_ID_DETECTOR_USAGE at 1.05× passthrough.
export const DETECTOR_RUN_QUOTAS: Record<PlanType, { included: number; overageLabel: string }> = {
  [PlanType.FREE]: { included: 100, overageLabel: "Hard cap (upgrade to continue)" },
  [PlanType.STARTER]: { included: Infinity, overageLabel: "Unlimited" },
  [PlanType.PRO]: { included: Infinity, overageLabel: "Unlimited" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Unlimited" },
};

// First N detector scans per billing period are billed at $0 even on paid
// plans — we absorb the hosted-LLM cost. This matches Free's 100-scan grant
// so upgrading from Free to Starter never *removes* a feature the customer
// already had. Beyond this threshold, hosted-LLM tokens are billed at 1.05×
// passthrough (proportional to the overage portion of the period total).
// BYOK scans bypass billing entirely regardless of this threshold.
export const DETECTOR_HOSTED_LLM_FREE_THRESHOLD = 100;

// Legacy compat — used by usageMetering and free-plan blocking
export const USAGE_CONFIG = {
  includedUnits: 50_000, // free plan span cap
} as const;

export function isFreePlanBlocked(currentUsage: number): boolean {
  if (!isBillingEnabled()) return false;
  return currentUsage >= USAGE_CONFIG.includedUnits;
}

/**
 * Check if event ingestion should be blocked for a given plan and usage.
 * Free plan: hard cap at the included span allowance (50k).
 * Paid plans: never blocked (overage is billed via Stripe).
 *
 * Mirrors isAiRunBlocked / isRcaRunBlocked / isDetectorRunBlocked. Ingestion
 * previously had only isFreePlanBlocked (no plan argument), so processWorkspace
 * gated it behind `if (isFreePlan)` and never cleared the flag on upgrade — a
 * workspace that tripped the Free cap and then upgraded stayed blocked
 * indefinitely. Returning false for paid plans here clears that stale block.
 */
export function isIngestionBlocked(plan: PlanType, totalEvents: number): boolean {
  if (!isBillingEnabled()) return false;
  if (plan === PlanType.FREE) {
    return totalEvents >= EVENT_QUOTAS[plan].included;
  }
  return false;
}

/**
 * Check if AI runs should be blocked for a given plan and usage.
 * Free plan: hard cap at included runs (30).
 * Paid plans: never blocked (overage is billed via Stripe).
 */
export function isAiRunBlocked(plan: PlanType, runsUsed: number): boolean {
  if (!isBillingEnabled()) return false;
  if (plan === PlanType.FREE) {
    return runsUsed >= AI_RUN_QUOTAS[plan].included;
  }
  return false; // paid plans: overage is billed via Stripe, never hard-blocked
}

/**
 * Check if RCA runs should be blocked for a given plan and usage.
 * Free plan: hard cap at included runs (30).
 * Paid plans: never blocked (overage is billed via Stripe).
 *
 * Mirrors isAiRunBlocked. The Free RCA cap (30) is lower than the Free
 * detector-scan cap (100), so detectorBlocked alone does NOT implicitly
 * cap RCA — a workspace can produce 30+ findings before hitting the
 * detector cap, each of which would otherwise trigger an RCA.
 */
export function isRcaRunBlocked(plan: PlanType, runsUsed: number): boolean {
  if (!isBillingEnabled()) return false;
  if (plan === PlanType.FREE) {
    return runsUsed >= RCA_RUN_QUOTAS[plan].included;
  }
  return false;
}

/**
 * Check if detector runs should be blocked for a given plan and usage.
 * Free plan: hard cap at 100 total scans (BYOK + hosted combined).
 * Paid plans: never blocked (hosted inference is billed at 1.05× passthrough; BYOK is free).
 */
export function isDetectorRunBlocked(plan: PlanType, scansRun: number): boolean {
  if (!isBillingEnabled()) return false;
  if (plan === PlanType.FREE) {
    return scansRun >= DETECTOR_RUN_QUOTAS[plan].included;
  }
  return false;
}

// =============================================================================
// SEAT LIMITS
// =============================================================================
export const SEAT_LIMITS: Record<PlanType, number> = {
  [PlanType.FREE]: 2,
  [PlanType.STARTER]: Infinity, // unlimited
  [PlanType.PRO]: Infinity, // unlimited
  [PlanType.ENTERPRISE]: Infinity, // unlimited
};

// =============================================================================
// FEATURE ENTITLEMENTS
// =============================================================================
const ENTITLEMENT_CONFIG = {
  "15d-retention": [PlanType.FREE],
  "30d-retention": [PlanType.STARTER],
  "90d-retention": [PlanType.PRO],
  "custom-retention": [PlanType.ENTERPRISE],
  "source-code-visible": [PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  "ai-chat-mode": [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  "ai-agent-mode": [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  "ai-auto-triage": [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  byok: [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  "github-integration": [PlanType.PRO, PlanType.ENTERPRISE],
  "slack-integration": [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE],
  soc2: [PlanType.PRO, PlanType.ENTERPRISE],
  "custom-compliance": [PlanType.ENTERPRISE],
  "sla-support": [PlanType.ENTERPRISE],
} as const;

// Derive types from the config
export type Entitlement = keyof typeof ENTITLEMENT_CONFIG;
export const ENTITLEMENTS = Object.keys(ENTITLEMENT_CONFIG) as Entitlement[];

// Get entitlements for a plan (computed from ENTITLEMENT_CONFIG)
function getEntitlementsForPlan(plan: PlanType): Entitlement[] {
  return (Object.entries(ENTITLEMENT_CONFIG) as [Entitlement, readonly string[]][])
    .filter(([_, plans]) => plans.includes(plan))
    .map(([entitlement]) => entitlement);
}

// =============================================================================
// PLAN DEFINITIONS
// =============================================================================
export const PLANS: Record<
  PlanType,
  {
    name: string;
    description: string;
    price: number | null; // null = custom/contact us
    billingPriceId: string;
    highlighted: boolean;
    badge: string | null;
    features: string[];
    support: string;
    entitlements: Entitlement[];
  }
> = {
  [PlanType.FREE]: {
    name: "Free",
    description: "Get started with core features",
    price: 0,
    billingPriceId: "",
    highlighted: false,
    badge: null,
    features: [
      "2 seats",
      "50k events/month included",
      "15-day retention",
      "30 chat runs/month",
      "30 RCA runs/month",
      "100 detector runs/month",
      "Slack alerts for detectors",
      "BYOK or hosted LLM",
    ],
    support: "Discord",
    entitlements: getEntitlementsForPlan(PlanType.FREE),
  },
  [PlanType.STARTER]: {
    name: "Starter",
    description: "For small teams",
    price: 30,
    billingPriceId: process.env.STRIPE_PRICE_ID_STARTER || "",
    highlighted: false,
    badge: null,
    features: [
      "Everything in Free",
      "Unlimited seats",
      "150k events/month included",
      "$4 per 50k overage events",
      "30-day retention",
      "100 chat runs/month",
      "$10 per 100 overage chat runs",
      "100 RCA runs/month",
      "$10 per 100 overage RCA runs",
      "Unlimited detector runs",
      "Hosted LLM: token cost × 1.05 on overage",
    ],
    support: "Discord",
    entitlements: getEntitlementsForPlan(PlanType.STARTER),
  },
  [PlanType.PRO]: {
    name: "Pro",
    description: "For growing teams",
    price: 200,
    billingPriceId: process.env.STRIPE_PRICE_ID_PRO || "",
    highlighted: true,
    badge: "Popular",
    features: [
      "Everything in Starter",
      "90-day retention",
      "20k ingest + 1k dashboard requests/min rate limits",
      "SOC2 compliance",
    ],
    support: "Discord + Slack",
    entitlements: getEntitlementsForPlan(PlanType.PRO),
  },
  [PlanType.ENTERPRISE]: {
    name: "Enterprise",
    description: "For scaling organizations",
    price: null, // custom pricing
    billingPriceId: "",
    highlighted: false,
    badge: null,
    features: ["Everything in Pro", "Custom retention", "SLA support"],
    support: "Discord + Slack + SLA",
    entitlements: getEntitlementsForPlan(PlanType.ENTERPRISE),
  },
};

export type PlanConfig = (typeof PLANS)[PlanType];

// =============================================================================
// PLAN HELPERS
// =============================================================================
export function getPlanConfig(plan: PlanType): PlanConfig {
  return PLANS[plan];
}

export function mapPriceIdToPlan(priceId: string | null): PlanType {
  if (!priceId) return PlanType.FREE;
  for (const [planKey, config] of Object.entries(PLANS)) {
    if (config.billingPriceId === priceId) {
      return planKey as PlanType;
    }
  }
  return PlanType.FREE;
}

export function getPlanOrder(plan: PlanType): number {
  const order: Record<PlanType, number> = {
    [PlanType.FREE]: 0,
    [PlanType.STARTER]: 1,
    [PlanType.PRO]: 2,
    [PlanType.ENTERPRISE]: 3,
  };
  return order[plan];
}

export function isUpgrade(currentPlan: PlanType, newPlan: PlanType): boolean {
  return getPlanOrder(newPlan) > getPlanOrder(currentPlan);
}

export function isDowngrade(currentPlan: PlanType, newPlan: PlanType): boolean {
  return getPlanOrder(newPlan) < getPlanOrder(currentPlan);
}

// =============================================================================
// ENTITLEMENT HELPERS
// =============================================================================
export function hasEntitlement(plan: PlanType, entitlement: Entitlement): boolean {
  if (!isBillingEnabled()) return true;
  return (ENTITLEMENT_CONFIG[entitlement] as readonly string[]).includes(plan);
}

export function getEntitlements(plan: PlanType): Entitlement[] {
  return PLANS[plan].entitlements;
}

export function requireEntitlement(
  plan: PlanType,
  entitlement: Entitlement,
  message?: string,
): void {
  if (!hasEntitlement(plan, entitlement)) {
    throw new Error(message ?? `Plan "${plan}" does not have access to "${entitlement}"`);
  }
}

// =============================================================================
// SEAT ENFORCEMENT
// =============================================================================
export function getSeatLimit(plan: PlanType): number {
  return SEAT_LIMITS[plan];
}

export function canAddSeat(plan: PlanType, currentSeatCount: number): boolean {
  if (!isBillingEnabled()) return true;
  const limit = SEAT_LIMITS[plan];
  return currentSeatCount < limit;
}

export function requireSeatAvailable(
  plan: PlanType,
  currentSeatCount: number,
  message?: string,
): void {
  if (!canAddSeat(plan, currentSeatCount)) {
    const limit = SEAT_LIMITS[plan];
    throw new Error(
      message ??
        `Plan "${plan}" is limited to ${limit} seat${limit === 1 ? "" : "s"}. ` +
          `Upgrade your plan to add more members.`,
    );
  }
}
