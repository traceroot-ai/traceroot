/**
 * Billing Worker
 *
 * Runs hourly to process all workspaces:
 * 1. Query usage (traces + spans) from ClickHouse ONCE per workspace
 * 2. Count AI runs (assistant messages) from PostgreSQL
 * 3. Update currentUsage JSON (for billing page display)
 * 4. Update ingestionBlocked / aiBlocked flags
 * 5. Report overage to Stripe (paid plans only)
 *
 * AI Run Billing:
 * - Free plan: hard cap at 30 runs/month (blocked when reached)
 * - Starter/Pro: first 100 runs free, then $10/100 runs + 1.05x system model token cost
 * - BYOK runs: only run fee, no token markup (user pays their own API)
 * - Stripe receives units at $0.01 each; TraceRoot calculates the unit count
 */

import Stripe from "stripe";
import { prisma, USAGE_CONFIG, PlanType, isAiRunBlocked, AI_RUN_QUOTAS } from "@traceroot/core";
import { getWorkspaceUsageDetails } from "./clickhouse";

let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    stripe = new Stripe(secretKey);
  }
  return stripe;
}

/**
 * Main billing job - processes all workspaces in a single pass.
 */
export async function runBillingJob(): Promise<void> {
  console.log("[Billing] Starting billing job...");

  try {
    const workspaces = await prisma.workspace.findMany({
      include: {
        projects: {
          where: { deleteTime: null },
          select: { id: true },
        },
      },
    });

    console.log(`[Billing] Processing ${workspaces.length} workspaces`);

    const now = new Date();
    const allTimeStart = new Date(0);

    let stripeClient: Stripe | null = null;
    try {
      stripeClient = getStripe();
    } catch {
      console.warn("[Billing] Stripe not configured, skipping Stripe updates");
    }

    for (const workspace of workspaces) {
      try {
        await processWorkspace(workspace, {
          now,
          allTimeStart,
          stripeClient,
        });
      } catch (error) {
        console.error(`[Billing] Error processing workspace ${workspace.id}:`, error);
      }
    }

    console.log("[Billing] Job completed successfully");
  } catch (error) {
    console.error("[Billing] Job failed:", error);
    throw error;
  }
}

async function processWorkspace(
  workspace: {
    id: string;
    billingPlan: string;
    billingCustomerId: string | null;
    billingSubscriptionId: string | null;
    billingPeriodStart: Date | null;
    billingPeriodEnd: Date | null;
    ingestionBlocked: boolean;
    aiBlocked: boolean;
    currentUsage: any;
    projects: { id: string }[];
  },
  ctx: {
    now: Date;
    allTimeStart: Date;
    stripeClient: Stripe | null;
  },
): Promise<void> {
  const projectIds = workspace.projects.map((p) => p.id);
  const plan = workspace.billingPlan as PlanType;
  const isFreePlan = plan === PlanType.FREE;

  // =========================================================================
  // 1. Query event usage (traces + spans) from ClickHouse
  // =========================================================================
  let usage: { traces: number; spans: number };
  if (projectIds.length === 0) {
    usage = { traces: 0, spans: 0 };
  } else {
    // Free plan: total usage (all time)
    // Paid plans: usage within current billing period (from Stripe webhook)
    let start: Date;
    let end: Date;

    if (isFreePlan) {
      start = ctx.allTimeStart;
      end = ctx.now;
    } else if (workspace.billingPeriodStart && workspace.billingPeriodEnd) {
      // Use billing period dates from Stripe (updated via webhook each month)
      start = workspace.billingPeriodStart;
      end = workspace.billingPeriodEnd;
    } else {
      // Fallback to calendar month if no billing period set
      start = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1);
      end = new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 1);
    }

    usage = await getWorkspaceUsageDetails({
      projectIds,
      start,
      end,
    });
  }

  const totalEvents = usage.traces + usage.spans;

  // =========================================================================
  // 2. Query AI usage from PostgreSQL
  // =========================================================================
  const aiPeriodStart = isFreePlan
    ? ctx.allTimeStart
    : (workspace.billingPeriodStart ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1));
  const aiPeriodEnd = isFreePlan
    ? ctx.now
    : (workspace.billingPeriodEnd ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 1));

  // 2a. Count total AI runs in period (both BYOK and system model)
  const runsUsed = await prisma.aIMessage.count({
    where: {
      role: "assistant",
      session: { workspaceId: workspace.id },
      createTime: { gte: aiPeriodStart, lt: aiPeriodEnd },
    },
  });

  // 2b. Aggregate system model token usage (for cost display + Stripe metering)
  const systemWhere = {
    role: "assistant" as const,
    inputTokens: { not: null as null },
    isByok: false as const,
    session: { workspaceId: workspace.id },
    createTime: { gte: aiPeriodStart, lt: aiPeriodEnd },
  };

  // BYOK models: always all-time (no billing cycle, for reference only)
  const byokWhere = {
    role: "assistant" as const,
    inputTokens: { not: null as null },
    isByok: true as const,
    session: { workspaceId: workspace.id },
  };

  const [systemAgg, byokAgg, systemByModel, byokByModel] = await Promise.all([
    prisma.aIMessage.aggregate({
      where: systemWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.aggregate({
      where: byokWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.groupBy({
      by: ["model", "provider", "isByok"],
      where: systemWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.groupBy({
      by: ["model", "provider", "isByok"],
      where: byokWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
  ]);

  const byModel = [...systemByModel, ...byokByModel];
  const systemCost = Number(systemAgg._sum.cost ?? 0);

  // =========================================================================
  // 3. Build update data
  // =========================================================================
  const updateData: {
    currentUsage: object;
    ingestionBlocked?: boolean;
    aiBlocked?: boolean;
  } = {
    currentUsage: {
      traces: usage.traces,
      spans: usage.spans,
      tokens: 0,
      updatedAt: ctx.now.toISOString(),
      ai: {
        runsUsed,
        systemUsage: {
          messages: systemAgg._count.id,
          inputTokens: systemAgg._sum.inputTokens ?? 0,
          outputTokens: systemAgg._sum.outputTokens ?? 0,
          cost: systemCost,
        },
        byokUsage: {
          messages: byokAgg._count.id,
          inputTokens: byokAgg._sum.inputTokens ?? 0,
          outputTokens: byokAgg._sum.outputTokens ?? 0,
          cost: Number(byokAgg._sum.cost ?? 0),
        },
        byModel: byModel.map((row) => ({
          model: row.model ?? "unknown",
          provider: row.provider ?? "unknown",
          isByok: row.isByok ?? false,
          messages: row._count.id,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          cost: Number(row._sum.cost ?? 0),
        })),
      },
    },
  };

  // =========================================================================
  // 4. Update blocking flags
  // =========================================================================

  // 4a. Event ingestion blocking (free plan only)
  if (isFreePlan) {
    const shouldBeBlocked = totalEvents >= USAGE_CONFIG.includedUnits;
    if (workspace.ingestionBlocked !== shouldBeBlocked) {
      updateData.ingestionBlocked = shouldBeBlocked;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${totalEvents}/${USAGE_CONFIG.includedUnits} events, blocked: ${shouldBeBlocked}`,
      );
    }
  }

  // 4b. AI run blocking
  if (isFreePlan) {
    // Free plan: hard cap based on run count
    const shouldBlockAi = isAiRunBlocked(plan, runsUsed);
    if (workspace.aiBlocked !== shouldBlockAi) {
      updateData.aiBlocked = shouldBlockAi;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${runsUsed}/${AI_RUN_QUOTAS[plan].included} AI runs, ai_blocked: ${shouldBlockAi}`,
      );
    }
  }

  // 4c. Paid plans: always unblock AI (overage is billed, not blocked)
  if (!isFreePlan && workspace.aiBlocked) {
    updateData.aiBlocked = false;
    console.log(`[Billing] Workspace ${workspace.id}: unblocking AI (paid plan)`);
  }

  // =========================================================================
  // 5. Stripe metering (paid plans only)
  // =========================================================================
  console.log(
    `[Billing] Stripe check: isFreePlan=${isFreePlan}, subscriptionId=${!!workspace.billingSubscriptionId}, customerId=${!!workspace.billingCustomerId}, stripeClient=${!!ctx.stripeClient}`,
  );
  if (
    !isFreePlan &&
    workspace.billingSubscriptionId &&
    workspace.billingCustomerId &&
    ctx.stripeClient
  ) {
    // 5a. Update Stripe subscription quantity for event usage
    await updateStripeQuantity(workspace.billingSubscriptionId, totalEvents, ctx.stripeClient);

    // 5b. Report AI run overage to Stripe
    const includedRuns = AI_RUN_QUOTAS[plan].included;
    const overageRuns = Math.max(0, runsUsed - includedRuns);

    // Calculate total billable units:
    // - Run overage: $10 per 100 runs = $0.10/run = 10 units/run @ $0.01/unit
    // - System model token cost on overage runs: 1.05x markup, converted to $0.01 units
    let totalBillableUnits = 0;
    let overageSystemCost = 0;

    if (overageRuns > 0) {
      const runOverageUnits = overageRuns * 10;

      // Get system model token cost for runs beyond the included quota
      overageSystemCost = await getOverageSystemModelCost(
        workspace.id,
        includedRuns,
        aiPeriodStart,
        aiPeriodEnd,
      );
      const tokenMarkupUnits = Math.round(overageSystemCost * 1.05 * 100);

      totalBillableUnits = runOverageUnits + tokenMarkupUnits;
    }

    // Delta calculation: only report the increase since last worker run
    // Reset tracking when billing period changes (prevents negative delta after period rollover)
    const previousUsage = workspace.currentUsage as any;
    const prevPeriodStart = previousUsage?.ai?.lastReportedPeriodStart ?? null;
    const currentPeriodStart = workspace.billingPeriodStart?.toISOString() ?? null;
    const lastReportedUnits =
      prevPeriodStart === currentPeriodStart ? (previousUsage?.ai?.lastReportedUnits ?? 0) : 0;
    const deltaUnits = totalBillableUnits - lastReportedUnits;

    console.log(
      `[Billing] AI run metering: runsUsed=${runsUsed}, included=${includedRuns}, overage=${overageRuns}, ` +
        `overageSystemCost=$${overageSystemCost.toFixed(4)}, totalUnits=${totalBillableUnits}, ` +
        `lastReported=${lastReportedUnits}, delta=${deltaUnits}`,
    );

    if (deltaUnits > 0) {
      const reported = await reportAiRunOverageToStripe(
        workspace.id,
        workspace.billingCustomerId!,
        deltaUnits,
        ctx.stripeClient,
      );
      if (reported) {
        (updateData.currentUsage as any).ai.lastReportedUnits = totalBillableUnits;
        (updateData.currentUsage as any).ai.lastReportedPeriodStart = currentPeriodStart;
      }
    } else {
      // Preserve last reported values
      (updateData.currentUsage as any).ai.lastReportedUnits = lastReportedUnits;
      (updateData.currentUsage as any).ai.lastReportedPeriodStart = currentPeriodStart;
    }
  }

  // =========================================================================
  // 6. Write to database
  // =========================================================================
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: updateData,
  });

  console.log(
    `[Billing] Workspace ${workspace.id} (${workspace.billingPlan}): ` +
      `${usage.traces} traces, ${usage.spans} spans | ` +
      `AI runs: ${runsUsed} | ` +
      `system: ${systemAgg._count.id} msgs ($${systemCost.toFixed(4)}) | ` +
      `byok: ${byokAgg._count.id} msgs (all-time)`,
  );
}

/**
 * Get the total system model token cost for AI runs beyond the included quota.
 * Orders all assistant messages by time, skips the first `includedRuns`,
 * then sums the cost of system model (non-BYOK) messages in the remainder.
 */
async function getOverageSystemModelCost(
  workspaceId: string,
  includedRuns: number,
  start: Date,
  end: Date,
): Promise<number> {
  const overageMessages = await prisma.aIMessage.findMany({
    where: {
      role: "assistant",
      session: { workspaceId },
      createTime: { gte: start, lt: end },
    },
    orderBy: { createTime: "asc" },
    skip: includedRuns,
    select: { isByok: true, cost: true },
  });

  return overageMessages
    .filter((m) => m.isByok === false)
    .reduce((sum, m) => sum + Number(m.cost ?? 0), 0);
}

async function updateStripeQuantity(
  subscriptionId: string,
  quantity: number,
  stripeClient: Stripe,
): Promise<void> {
  try {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    // Find the plan item (not the AI usage metered item)
    const aiUsagePriceId = process.env.STRIPE_PRICE_ID_AI_USAGE;
    const planItem = subscription.items.data.find((item) => item.price.id !== aiUsagePriceId);

    if (!planItem) {
      console.warn(`[Billing] No plan subscription item found for ${subscriptionId}`);
      return;
    }

    if (planItem.quantity !== quantity) {
      await stripeClient.subscriptionItems.update(planItem.id, {
        quantity,
        proration_behavior: "none",
      });
      console.log(`[Billing] Updated Stripe quantity: ${planItem.quantity} -> ${quantity}`);
    }
  } catch (error) {
    console.error(`[Billing] Failed to update Stripe for subscription ${subscriptionId}:`, error);
  }
}

/**
 * Report AI run overage to Stripe via meter events.
 * Units are at $0.01 each. The unit count includes both:
 * - Run overage fee: $10/100 runs = 10 units per overage run
 * - System model token markup: 1.05x of token cost on overage runs
 * Returns true if successfully reported.
 */
async function reportAiRunOverageToStripe(
  workspaceId: string,
  customerId: string,
  units: number,
  stripeClient: Stripe,
): Promise<boolean> {
  if (units <= 0) return false;

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: "ai_token_usage",
      payload: {
        stripe_customer_id: customerId,
        value: String(units),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log(
      `[Billing] Reported AI run overage to Stripe: workspace=${workspaceId}, delta=${units} units ($${(units * 0.01).toFixed(2)})`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to report AI run overage to Stripe for workspace ${workspaceId}:`,
      error,
    );
    return false;
  }
}
