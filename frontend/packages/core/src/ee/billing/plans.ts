import { isBillingEnabled } from "../license";
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
  [PlanType.STARTER]: { included: 150_000, overageLabel: "$3 per 50k events" },
  [PlanType.PRO]: { included: 150_000, overageLabel: "$3 per 50k events" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Custom" },
};

// AI runs
export const AI_RUN_QUOTAS: Record<PlanType, { included: number; overageLabel: string }> = {
  [PlanType.FREE]: { included: 30, overageLabel: "Hard cap (upgrade to continue)" },
  [PlanType.STARTER]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.PRO]: { included: 100, overageLabel: "$10 per 100 runs" },
  [PlanType.ENTERPRISE]: { included: Infinity, overageLabel: "Unlimited" },
};

// Legacy compat — used by usageMetering and free-plan blocking
export const USAGE_CONFIG = {
  includedUnits: 50_000, // free plan span cap
} as const;

export function isFreePlanBlocked(currentUsage: number): boolean {
  if (!isBillingEnabled()) return false;
  return currentUsage >= USAGE_CONFIG.includedUnits;
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
  "slack-integration": [PlanType.PRO, PlanType.ENTERPRISE],
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
      "30 AI runs/month",
      "BYOK supported",
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
      "$3 per 50k overage events",
      "30-day retention",
      "100 AI runs/month",
      "$10 per 100 overage runs",
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
      "Higher rate limits",
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
    features: ["Everything in Pro", "Custom retention", "Slack + SLA support"],
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
// DATA RETENTION
// =============================================================================

// Retention window in days per plan (null = custom / no enforced limit)
export const RETENTION_DAYS: Record<PlanType, number | null> = {
  [PlanType.FREE]: 15,
  [PlanType.STARTER]: 30,
  [PlanType.PRO]: 90,
  [PlanType.ENTERPRISE]: null,
};

/**
 * Get the effective data retention TTL in days for a plan.
 *
 * Returns null when:
 * - Billing is disabled (self-hosted, no limits enforced)
 * - Enterprise plan without a custom TTL set on the project
 *
 * @param plan          The workspace's billing plan
 * @param customTtlDays Per-project override (used for Enterprise plans)
 */
export function getRetentionDays(plan: PlanType, customTtlDays?: number | null): number | null {
  if (!isBillingEnabled()) return null;
  const planDays = RETENTION_DAYS[plan];
  if (planDays !== null) return planDays;
  return customTtlDays ?? null;
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
