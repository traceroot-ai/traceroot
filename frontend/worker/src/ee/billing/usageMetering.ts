/**
 * Billing Worker
 *
 * Runs hourly to process all workspaces:
 * 1. Query usage (traces + spans) from ClickHouse ONCE per workspace
 * 2. Update currentUsage JSON (for billing page display)
 * 3. Update ingestionBlocked flag (free plan only)
 * 4. Update Stripe subscription quantity (paid plans only)
 */

import Stripe from "stripe";
import { prisma, USAGE_CONFIG, PlanType } from "@traceroot/core";
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
  const isFreePlan = workspace.billingPlan === PlanType.FREE;

  // 1. Query usage ONCE
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

  // 1b. Query AI token usage from ai_messages (same time range as events)
  const aiStart = isFreePlan
    ? ctx.allTimeStart
    : (workspace.billingPeriodStart ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1));
  const aiEnd = isFreePlan
    ? ctx.now
    : (workspace.billingPeriodEnd ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 1));

  const aiUsageWhere = {
    role: "assistant" as const,
    inputTokens: { not: null as null },
    session: { workspaceId: workspace.id },
    createTime: { gte: aiStart, lt: aiEnd },
  };

  const [systemAgg, byokAgg, byModel] = await Promise.all([
    prisma.aIMessage.aggregate({
      where: { ...aiUsageWhere, isByok: false },
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.aIMessage.aggregate({
      where: { ...aiUsageWhere, isByok: true },
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.aIMessage.groupBy({
      by: ["model", "provider", "isByok"],
      where: aiUsageWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
  ]);

  // Calculate total system tokens (for free allowance check)
  const totalSystemTokens =
    (systemAgg._sum.inputTokens ?? 0) + (systemAgg._sum.outputTokens ?? 0);

  // 2. Build update data
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
        systemUsage: {
          messages: systemAgg._count.id,
          inputTokens: systemAgg._sum.inputTokens ?? 0,
          outputTokens: systemAgg._sum.outputTokens ?? 0,
          costUsd: Number(systemAgg._sum.costUsd ?? 0),
        },
        byokUsage: {
          messages: byokAgg._count.id,
          inputTokens: byokAgg._sum.inputTokens ?? 0,
          outputTokens: byokAgg._sum.outputTokens ?? 0,
          costUsd: Number(byokAgg._sum.costUsd ?? 0),
        },
        byModel: byModel.map((row) => ({
          model: row.model ?? "unknown",
          provider: row.provider ?? "unknown",
          isByok: row.isByok ?? false,
          messages: row._count.id,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          costUsd: Number(row._sum.costUsd ?? 0),
        })),
      },
    },
  };

  // 3. For free plan: update ingestionBlocked and aiBlocked
  if (isFreePlan) {
    const shouldBeBlocked = totalEvents >= USAGE_CONFIG.includedUnits;
    if (workspace.ingestionBlocked !== shouldBeBlocked) {
      updateData.ingestionBlocked = shouldBeBlocked;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${totalEvents}/${USAGE_CONFIG.includedUnits} events, blocked: ${shouldBeBlocked}`,
      );
    }

    // Block AI when free allowance exceeded (free plan has no subscription to bill)
    const shouldBlockAi = totalSystemTokens >= USAGE_CONFIG.aiIncludedTokens;
    if (workspace.aiBlocked !== shouldBlockAi) {
      updateData.aiBlocked = shouldBlockAi;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${totalSystemTokens}/${USAGE_CONFIG.aiIncludedTokens} AI tokens, ai_blocked: ${shouldBlockAi}`,
      );
    }
  }

  // 4. For paid plans with subscription: update Stripe before DB write
  if (!isFreePlan && workspace.billingSubscriptionId && ctx.stripeClient) {
    await updateStripeQuantity(workspace.billingSubscriptionId, totalEvents, ctx.stripeClient);

    // 4b. Report AI usage delta (system models only — BYOK is not billed)
    // Only bill for tokens above the free allowance (1M tokens)
    // Calculate billable cost: proportional to tokens above allowance
    const systemCostUsd = Number(systemAgg._sum.costUsd ?? 0);
    const billableCostUsd = totalSystemTokens > USAGE_CONFIG.aiIncludedTokens
      ? systemCostUsd * (totalSystemTokens - USAGE_CONFIG.aiIncludedTokens) / totalSystemTokens
      : 0;

    // Meter events are additive, so only report the increase since last run
    const previousUsage = workspace.currentUsage as any;
    const lastReportedCost = previousUsage?.ai?.lastReportedCostUsd ?? 0;
    const deltaCost = billableCostUsd - lastReportedCost;

    if (deltaCost > 0) {
      const reported = await reportAIUsageToStripe(
        workspace.id,
        workspace.billingCustomerId!,
        deltaCost,
        ctx.stripeClient,
      );
      if (reported) {
        // Track what we've reported so we don't double-report
        (updateData.currentUsage as any).ai.lastReportedCostUsd = billableCostUsd;
      }
    } else {
      // Preserve last reported value
      (updateData.currentUsage as any).ai.lastReportedCostUsd = lastReportedCost;
    }
  }

  // 5. Update database (after Stripe so lastReportedCostUsd is accurate)
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: updateData,
  });

  const aiMessages = systemAgg._count.id + byokAgg._count.id;
  const aiInputTokens = (systemAgg._sum.inputTokens ?? 0) + (byokAgg._sum.inputTokens ?? 0);
  const aiOutputTokens = (systemAgg._sum.outputTokens ?? 0) + (byokAgg._sum.outputTokens ?? 0);

  console.log(
    `[Billing] Workspace ${workspace.id} (${workspace.billingPlan}): ${usage.traces} traces, ${usage.spans} spans, ${aiMessages} AI messages (${aiInputTokens} in / ${aiOutputTokens} out tokens)`,
  );
}

async function updateStripeQuantity(
  subscriptionId: string,
  quantity: number,
  stripeClient: Stripe,
): Promise<void> {
  try {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    // Find the plan item (not the AI usage metered item)
    const aiUsagePriceId = process.env.STRIPE_AI_USAGE_PRICE_ID;
    const planItem = subscription.items.data.find(
      (item) => item.price.id !== aiUsagePriceId,
    );

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
 * Report AI token usage cost to Stripe via meter events.
 * Converts costUsd to cents (units at $0.01 each).
 * Only reports system model usage — BYOK is not billed.
 * Returns true if successfully reported.
 */
async function reportAIUsageToStripe(
  workspaceId: string,
  customerId: string,
  costUsd: number,
  stripeClient: Stripe,
): Promise<boolean> {
  const costCents = Math.round(costUsd * 100);
  if (costCents <= 0) return false;

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: "ai_token_usage",
      payload: {
        stripe_customer_id: customerId,
        value: String(costCents),
      },
    });
    console.log(
      `[Billing] Reported AI usage to Stripe: workspace=${workspaceId}, delta=$${costUsd.toFixed(2)} (${costCents} units)`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to report AI usage to Stripe for workspace ${workspaceId}:`,
      error,
    );
    return false;
  }
}
