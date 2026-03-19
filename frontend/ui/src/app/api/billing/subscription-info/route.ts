import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma, getStripeOrThrow, mapPriceIdToPlan } from "@traceroot/core";

export interface SubscriptionInfo {
  cancellation: { cancelAt: Date } | null;
  scheduledChange: { switchAt: Date; newPlan: string } | null; // newPlan is now the plan name (e.g., "starter", "pro")
  billingPeriod: { start: Date; end: Date } | null;
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) {
      return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
    }

    const workspace = await prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId: session.user.id } },
      },
    });

    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    // No subscription = free plan, no extra info needed
    if (!workspace.billingSubscriptionId) {
      const info: SubscriptionInfo = {
        cancellation: null,
        scheduledChange: null,
        billingPeriod: null,
      };
      return NextResponse.json(info);
    }

    const stripe = getStripeOrThrow();

    // Fetch live subscription from Stripe
    const subscription = await stripe.subscriptions.retrieve(workspace.billingSubscriptionId, {
      expand: ["schedule"],
    });

    const nowSec = Math.floor(Date.now() / 1000);

    // Check for cancellation
    let cancellation: SubscriptionInfo["cancellation"] = null;
    if (typeof subscription.cancel_at === "number" && subscription.cancel_at > nowSec) {
      cancellation = { cancelAt: new Date(subscription.cancel_at * 1000) };
    } else if (subscription.cancel_at_period_end === true) {
      cancellation = {
        cancelAt: new Date(subscription.current_period_end * 1000),
      };
    }

    // Billing period
    const billingPeriod: SubscriptionInfo["billingPeriod"] = {
      start: new Date(subscription.current_period_start * 1000),
      end: new Date(subscription.current_period_end * 1000),
    };

    // Check for scheduled plan change (downgrade)
    let scheduledChange: SubscriptionInfo["scheduledChange"] = null;
    const schedule = subscription.schedule;
    if (
      schedule &&
      typeof schedule === "object" &&
      "status" in schedule &&
      ["active", "not_started"].includes(schedule.status)
    ) {
      const fullSchedule = await stripe.subscriptionSchedules.retrieve(schedule.id);
      const phases = fullSchedule.phases ?? [];
      const nextPhase = phases.find((p) => (p.start_date ?? 0) > nowSec);

      if (nextPhase && nextPhase.items?.[0]) {
        const priceId = nextPhase.items[0].price as string;
        const newPlanName = mapPriceIdToPlan(priceId);
        scheduledChange = {
          switchAt: new Date((nextPhase.start_date ?? 0) * 1000),
          newPlan: newPlanName,
        };
      }
    }

    const info: SubscriptionInfo = {
      cancellation,
      scheduledChange,
      billingPeriod,
    };

    return NextResponse.json(info);
  } catch (error) {
    console.error("Subscription info error:", error);
    return NextResponse.json({ error: "Failed to get subscription info" }, { status: 500 });
  }
}
