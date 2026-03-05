import { isBillingEnabled } from "../license";
export { isBillingEnabled };

// =============================================================================
// PLAN TYPES
// =============================================================================
export const PlanType = {
  FREE: "free",
  STARTER: "starter",
  PRO: "pro",
  STARTUPS: "startups",
} as const;
export type PlanType = (typeof PlanType)[keyof typeof PlanType];

// =============================================================================
// STRIPE USAGE PRICING
// =============================================================================
// Each plan uses graduated tiered pricing:
// - Tier 1: 0-10k events included in base price
// - Tier 2: 10k+ events at $0.02/event
export const USAGE_PRICING_DESCRIPTION = "10k events included, then $0.02/event";
export const USAGE_CONFIG = {
  includedUnits: 10_000,
  aiIncludedCostUsd: 5, // $5 free AI usage per billing period (all plans)
} as const;

export function isFreePlanBlocked(currentUsage: number): boolean {
  if (!isBillingEnabled()) return false;
  return currentUsage >= USAGE_CONFIG.includedUnits;
}

// =============================================================================
// SEAT LIMITS
// =============================================================================
// Seats are enforced: users cannot exceed the limit for their plan
export const SEAT_LIMITS: Record<PlanType, number> = {
  [PlanType.FREE]: 1,
  [PlanType.STARTER]: 5,
  [PlanType.PRO]: Infinity, // unlimited
  [PlanType.STARTUPS]: Infinity, // unlimited
};

// =============================================================================
// FEATURE ENTITLEMENTS
// =============================================================================
// Features are boolean flags - you either have access or you don't
const ENTITLEMENT_CONFIG = {
  "7d-retention": [PlanType.FREE],
  "30d-retention": [PlanType.STARTER, PlanType.PRO, PlanType.STARTUPS],
  "source-code-visible": [PlanType.STARTER, PlanType.PRO, PlanType.STARTUPS],
  "ai-chat-mode": [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.STARTUPS],
  "ai-agent-mode": [PlanType.PRO, PlanType.STARTUPS],
  "ai-auto-triage": [PlanType.PRO, PlanType.STARTUPS],
  byok: [PlanType.FREE, PlanType.STARTER, PlanType.PRO, PlanType.STARTUPS],
  "github-integration": [PlanType.PRO, PlanType.STARTUPS],
  "slack-notion-integration": [PlanType.STARTUPS],
  "soc2-iso27001": [PlanType.STARTUPS],
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
    price: number;
    billingPriceId: string;
    highlighted: boolean;
    badge: string | null;
    features: string[];
    entitlements: Entitlement[];
  }
> = {
  [PlanType.FREE]: {
    name: "Free",
    description: "Get started with basic features",
    price: 0,
    billingPriceId: "",
    highlighted: false,
    badge: null,
    features: ["1 seat", "10k events/month (traces + spans)", "7d retention", "AI chat mode", "Bring your own API keys (BYOK)"],
    entitlements: getEntitlementsForPlan(PlanType.FREE),
  },
  [PlanType.STARTER]: {
    name: "Starter",
    description: "For individuals and small teams",
    price: 49,
    billingPriceId: process.env.STRIPE_PRICE_ID_STARTER || "",
    highlighted: false,
    badge: null,
    features: [
      "Up to 5 seats",
      "10k events included",
      "$0.02/event after 10k",
      "30d retention",
      "Source code visible in UI",
      "AI chat mode",
      "Bring your own API keys (BYOK)",
    ],
    entitlements: getEntitlementsForPlan(PlanType.STARTER),
  },
  [PlanType.PRO]: {
    name: "Pro",
    description: "For growing teams",
    price: 99,
    billingPriceId: process.env.STRIPE_PRICE_ID_PRO || "",
    highlighted: true,
    badge: "Popular",
    features: [
      "Everything in Starter",
      "Unlimited seats",
      "AI chat + agent mode",
      "GitHub integration",
      "AI auto-triaging",
    ],
    entitlements: getEntitlementsForPlan(PlanType.PRO),
  },
  [PlanType.STARTUPS]: {
    name: "Startups",
    description: "For scaling organizations",
    price: 999,
    billingPriceId: process.env.STRIPE_PRICE_ID_STARTUPS || "",
    highlighted: false,
    badge: null,
    features: [
      "Everything in Pro",
      "Slack & Notion integration",
      "SOC2 & ISO27001 reports",
      "Priority support",
    ],
    entitlements: getEntitlementsForPlan(PlanType.STARTUPS),
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
    [PlanType.STARTUPS]: 3,
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
