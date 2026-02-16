/**
 * Usage Metering Worker
 *
 * Runs periodically to:
 * 1. Query backend API for trace + span counts per workspace
 * 2. Update Stripe subscription item quantity (for tiered pricing)
 *
 * Tiered pricing is the same for all plans (configured in Stripe).
 */

import Stripe from "stripe";
import { prisma, USAGE_PRICE_ID, USAGE_CONFIG } from "@traceroot/core";
import { getWorkspaceUsageInPeriod } from "./clickhouse";

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
 * Main usage metering job.
 * Updates Stripe subscription quantities based on actual usage.
 */
export async function runUsageMeteringJob(): Promise<void> {
  console.log("[UsageMetering] Starting usage metering job...");

  try {
    // Get all workspaces with active subscriptions
    const workspaces = await prisma.workspace.findMany({
      where: {
        billingSubscriptionId: { not: null },
      },
      include: {
        projects: {
          where: { deleteTime: null },
          select: { id: true },
        },
      },
    });

    console.log(`[UsageMetering] Processing ${workspaces.length} workspaces with subscriptions`);

    const stripeClient = getStripe();

    for (const workspace of workspaces) {
      try {
        await updateWorkspaceUsage(workspace, stripeClient);
      } catch (error) {
        console.error(
          `[UsageMetering] Error processing workspace ${workspace.id}:`,
          error,
        );
      }
    }

    console.log("[UsageMetering] Job completed successfully");
  } catch (error) {
    console.error("[UsageMetering] Job failed:", error);
    throw error;
  }
}

/**
 * Update usage quantity for a single workspace's subscription.
 */
async function updateWorkspaceUsage(
  workspace: {
    id: string;
    billingSubscriptionId: string | null;
    billingPeriodStart: Date | null;
    projects: { id: string }[];
  },
  stripeClient: Stripe,
): Promise<void> {
  if (!workspace.billingSubscriptionId) {
    return;
  }

  const projectIds = workspace.projects.map((p) => p.id);
  if (projectIds.length === 0) {
    return;
  }

  // Get billing period (from subscription or start of current month)
  const now = new Date();
  const billingPeriodStart = workspace.billingPeriodStart
    ? new Date(workspace.billingPeriodStart)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const billingPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  // Get total usage for this billing period
  const totalEvents = await getWorkspaceUsageInPeriod({
    projectIds,
    start: billingPeriodStart,
    end: billingPeriodEnd,
  });

  // Quantity = actual event count (Stripe tiered pricing handles the tiers)
  const quantity = totalEvents;

  console.log(
    `[UsageMetering] Workspace ${workspace.id}: ${totalEvents} events`,
  );

  // Get the subscription and find the usage price item
  const subscription = await stripeClient.subscriptions.retrieve(
    workspace.billingSubscriptionId,
  );

  const usageItem = subscription.items.data.find(
    (item) => item.price.id === USAGE_PRICE_ID,
  );

  if (!usageItem) {
    console.warn(
      `[UsageMetering] No usage item found for workspace ${workspace.id}`,
    );
    return;
  }

  // Update quantity if changed
  if (usageItem.quantity !== quantity) {
    await stripeClient.subscriptionItems.update(usageItem.id, {
      quantity: quantity,
      proration_behavior: "none", // Don't prorate mid-period, charge at end
    });

    console.log(
      `[UsageMetering] Updated workspace ${workspace.id} quantity: ${usageItem.quantity} -> ${quantity}`,
    );
  }
}

/**
 * Get current usage for a workspace (for API/UI display).
 */
export async function getCurrentWorkspaceUsage(workspaceId: string): Promise<{
  currentUsage: number;
  includedUnits: number;
  billableUsage: number;
}> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      projects: {
        where: { deleteTime: null },
        select: { id: true },
      },
    },
  });

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  // Calculate billing period
  const now = new Date();
  const billingPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const billingPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const projectIds = workspace.projects.map((p) => p.id);
  const currentUsage =
    projectIds.length > 0
      ? await getWorkspaceUsageInPeriod({
          projectIds,
          start: billingPeriodStart,
          end: billingPeriodEnd,
        })
      : 0;

  const billableUsage = Math.max(0, currentUsage - USAGE_CONFIG.includedUnits);

  return {
    currentUsage,
    includedUnits: USAGE_CONFIG.includedUnits,
    billableUsage,
  };
}
