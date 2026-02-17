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
import { prisma, USAGE_PRICE_ID, USAGE_CONFIG, PlanType } from "@traceroot/core";
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
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
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
          monthStart,
          monthEnd,
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
    billingSubscriptionId: string | null;
    billingPeriodStart: Date | null;
    ingestionBlocked: boolean;
    projects: { id: string }[];
  },
  ctx: {
    now: Date;
    monthStart: Date;
    monthEnd: Date;
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
    // Free plan: total usage (all time), Paid plans: monthly usage
    const start = isFreePlan ? ctx.allTimeStart : ctx.monthStart;
    usage = await getWorkspaceUsageDetails({
      projectIds,
      start,
      end: ctx.monthEnd,
    });
  }

  const totalEvents = usage.traces + usage.spans;

  // 2. Build update data
  const updateData: {
    currentUsage: object;
    ingestionBlocked?: boolean;
  } = {
    currentUsage: {
      traces: usage.traces,
      spans: usage.spans,
      tokens: 0,
      updatedAt: ctx.now.toISOString(),
    },
  };

  // 3. For free plan: update ingestionBlocked
  if (isFreePlan) {
    const shouldBeBlocked = totalEvents >= USAGE_CONFIG.includedUnits;
    if (workspace.ingestionBlocked !== shouldBeBlocked) {
      updateData.ingestionBlocked = shouldBeBlocked;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${totalEvents}/${USAGE_CONFIG.includedUnits} events, blocked: ${shouldBeBlocked}`,
      );
    }
  }

  // 4. Update database
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: updateData,
  });

  // 5. For paid plans with subscription: update Stripe
  if (!isFreePlan && workspace.billingSubscriptionId && ctx.stripeClient) {
    await updateStripeQuantity(workspace.billingSubscriptionId, totalEvents, ctx.stripeClient);
  }

  console.log(
    `[Billing] Workspace ${workspace.id} (${workspace.billingPlan}): ${usage.traces} traces, ${usage.spans} spans`,
  );
}

async function updateStripeQuantity(
  subscriptionId: string,
  quantity: number,
  stripeClient: Stripe,
): Promise<void> {
  try {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    const usageItem = subscription.items.data.find((item) => item.price.id === USAGE_PRICE_ID);

    if (!usageItem) {
      console.warn(`[Billing] No usage item found for subscription ${subscriptionId}`);
      return;
    }

    if (usageItem.quantity !== quantity) {
      await stripeClient.subscriptionItems.update(usageItem.id, {
        quantity,
        proration_behavior: "none",
      });
      console.log(`[Billing] Updated Stripe quantity: ${usageItem.quantity} -> ${quantity}`);
    }
  } catch (error) {
    console.error(`[Billing] Failed to update Stripe for subscription ${subscriptionId}:`, error);
  }
}
