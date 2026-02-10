// Define each entitlement once with its plans
const ENTITLEMENT_CONFIG = {
  "1-seat-only": ["free"],
  "up-to-5-seats": ["starter"],
  "unlimited-seats": ["pro", "startups"],
  "10k-traces": ["free"],
  "100k-traces": ["starter", "pro"],
  "5M-traces": ["startups"],
  "100k-llm-tokens": ["free"],
  "1M-llm-tokens": ["starter", "pro"],
  "50M-llm-tokens": ["startups"],
  "7d-retention": ["free"],
  "30d-retention": ["starter", "pro", "startups"],
  "source-code-visible": ["starter", "pro", "startups"],
  "ai-chat-mode": ["free", "starter", "pro", "startups"],
  "ai-agent-mode": ["pro", "startups"],
  "ai-auto-triage": ["pro", "startups"],
  "github-integration": ["pro", "startups"],
  "slack-notion-integration": ["startups"],
  "soc2-iso27001": ["startups"],
} as const;

// Derive types from the config
export type Entitlement = keyof typeof ENTITLEMENT_CONFIG;
export const ENTITLEMENTS = Object.keys(ENTITLEMENT_CONFIG) as Entitlement[];

// Plan types
export type PlanType = "free" | "starter" | "pro" | "startups";

// Get entitlements for a plan (computed from ENTITLEMENT_CONFIG)
function getEntitlementsForPlan(plan: PlanType): Entitlement[] {
  return (Object.entries(ENTITLEMENT_CONFIG) as [Entitlement, readonly string[]][])
    .filter(([_, plans]) => plans.includes(plan))
    .map(([entitlement]) => entitlement);
}

// Single source of truth for all plan data
export const PLANS: Record<PlanType, {
  name: string;
  description: string;
  price: number;
  billingPriceId: string;
  highlighted: boolean;
  badge: string | null;
  features: string[];
  entitlements: Entitlement[];
}> = {
  free: {
    name: "Free",
    description: "Get started with basic features",
    price: 0,
    billingPriceId: process.env.STRIPE_PRICE_ID_FREE || "",
    highlighted: false,
    badge: null,
    features: [
      "1 seat only",
      "10k trace + logs",
      "100k LLM tokens",
      "7d retention",
      "AI agent with chat mode only",
    ],
    entitlements: getEntitlementsForPlan("free"),
  },
  starter: {
    name: "Starter",
    description: "For individuals and small teams",
    price: 49,
    billingPriceId: process.env.STRIPE_PRICE_ID_STARTER || "",
    highlighted: false,
    badge: null,
    features: [
      "Up to 1 workspace",
      "Up to 5 seats",
      "100k trace + logs",
      "1M LLM tokens",
      "30d retention",
      "Source code visible in UI",
      "AI agent with chat mode only",
    ],
    entitlements: getEntitlementsForPlan("starter"),
  },
  pro: {
    name: "Pro",
    description: "For all your extra messaging needs",
    price: 99,
    billingPriceId: process.env.STRIPE_PRICE_ID_PRO || "",
    highlighted: true,
    badge: "Popular",
    features: [
      "Everything in Starter",
      "Unlimited users",
      "AI agent has chat + agent mode",
      "Optional full codebase access (GitHub integration)",
      "AI Agent auto-triaging production issues",
    ],
    entitlements: getEntitlementsForPlan("pro"),
  },
  startups: {
    name: "Startups",
    description: "For those of you who are really serious",
    price: 999,
    billingPriceId: process.env.STRIPE_PRICE_ID_STARTUPS || "",
    highlighted: false,
    badge: null,
    features: [
      "Everything in Pro",
      "5M trace + logs",
      "50M LLM tokens",
      "Slack & Notion integration, full GitHub support with ticket/PR context",
      "SOC2 & ISO27001 reports, BAA available (HIPAA)",
    ],
    entitlements: getEntitlementsForPlan("startups"),
  },
};

export type PlanConfig = (typeof PLANS)[PlanType];

// Helper functions
export function getPlanConfig(plan: PlanType): PlanConfig {
  return PLANS[plan];
}

export function mapPriceIdToPlan(priceId: string | null): PlanType {
  if (!priceId) return "free";
  for (const [planKey, config] of Object.entries(PLANS)) {
    if (config.billingPriceId === priceId) {
      return planKey as PlanType;
    }
  }
  return "free";
}

export function getPlanOrder(plan: PlanType): number {
  const order: Record<PlanType, number> = {
    free: 0,
    starter: 1,
    pro: 2,
    startups: 3,
  };
  return order[plan];
}

export function isUpgrade(currentPlan: PlanType, newPlan: PlanType): boolean {
  return getPlanOrder(newPlan) > getPlanOrder(currentPlan);
}

export function isDowngrade(currentPlan: PlanType, newPlan: PlanType): boolean {
  return getPlanOrder(newPlan) < getPlanOrder(currentPlan);
}

// Entitlement helpers
export function hasEntitlement(plan: PlanType, entitlement: Entitlement): boolean {
  return (ENTITLEMENT_CONFIG[entitlement] as readonly string[]).includes(plan);
}

export function getEntitlements(plan: PlanType): Entitlement[] {
  return PLANS[plan].entitlements;
}

export function requireEntitlement(
  plan: PlanType,
  entitlement: Entitlement,
  message?: string
): void {
  if (!hasEntitlement(plan, entitlement)) {
    throw new Error(
      message ?? `Plan "${plan}" does not have access to "${entitlement}"`
    );
  }
}
