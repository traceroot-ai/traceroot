import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, getStripeOrThrow, getPlanConfig, isUpgrade, PlanType } from "@traceroot/core";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, newPlan } = await req.json();
    const newPlanConfig = getPlanConfig(newPlan as PlanType);

    // Get workspace
    const workspace = await prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId: session.user.id, role: "ADMIN" } },
      },
    });
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const stripe = getStripeOrThrow();
    const currentPlan = workspace.billingPlan as PlanType;

    console.log("Change plan request:", {
      currentPlan,
      newPlan,
      isUpgradeResult: isUpgrade(currentPlan, newPlan as PlanType),
      subscriptionId: workspace.billingSubscriptionId,
      newPriceId: newPlanConfig.billingPriceId,
    });

    // Case 0: Same plan, nothing to do
    if (currentPlan === newPlan) {
      return NextResponse.json({ success: true, message: "Already on this plan" });
    }

    // Case 1: Downgrade to free = cancel subscription at period end
    if (newPlan === PlanType.FREE) {
      if (!workspace.billingSubscriptionId) {
        // Already on free, nothing to do
        return NextResponse.json({ success: true, message: "Already on free plan" });
      }

      // First, release any existing schedule
      const subscription = await stripe.subscriptions.retrieve(workspace.billingSubscriptionId);
      if (subscription.schedule) {
        const scheduleId =
          typeof subscription.schedule === "string"
            ? subscription.schedule
            : subscription.schedule.id;
        await stripe.subscriptionSchedules.release(scheduleId);
      }

      // Cancel at period end (user keeps access until period ends)
      await stripe.subscriptions.update(workspace.billingSubscriptionId, {
        cancel_at_period_end: true,
      });

      return NextResponse.json({
        success: true,
        message: "Subscription will be canceled at period end",
      });
    }

    // Case 2: No subscription yet = need to go through checkout
    if (!workspace.billingSubscriptionId) {
      return NextResponse.json(
        {
          error: "No subscription. Use checkout endpoint instead.",
          redirect: "/api/billing/checkout",
        },
        { status: 400 },
      );
    }

    // Case 3: Has subscription, changing to another paid plan
    const subscription = await stripe.subscriptions.retrieve(workspace.billingSubscriptionId);

    // Find the plan item (non-metered) vs AI usage item (metered)
    const aiUsagePriceId = process.env.STRIPE_AI_USAGE_PRICE_ID;
    const planItem = subscription.items.data.find(
      (item) => item.price.id !== aiUsagePriceId,
    );

    if (!planItem) {
      return NextResponse.json({ error: "Plan subscription item not found" }, { status: 500 });
    }

    const subscriptionItemId = planItem.id;

    // If subscription is set to cancel, remove that first
    if (subscription.cancel_at_period_end) {
      await stripe.subscriptions.update(workspace.billingSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    if (isUpgrade(currentPlan, newPlan as PlanType)) {
      // UPGRADE: Immediate change with proration
      // First, release any existing schedule (e.g., pending downgrade)
      if (subscription.schedule) {
        const scheduleId =
          typeof subscription.schedule === "string"
            ? subscription.schedule
            : subscription.schedule.id;
        await stripe.subscriptionSchedules.release(scheduleId);
      }

      console.log("Upgrading subscription:", {
        subscriptionId: workspace.billingSubscriptionId,
        itemId: subscriptionItemId,
        newPriceId: newPlanConfig.billingPriceId,
      });

      const updatedSub = await stripe.subscriptions.update(workspace.billingSubscriptionId!, {
        items: [
          {
            id: subscriptionItemId,
            price: newPlanConfig.billingPriceId,
            quantity: planItem.quantity ?? 1, // Preserve current usage quantity
          },
        ],
        proration_behavior: "always_invoice",
      });

      console.log("Stripe subscription updated:", {
        id: updatedSub.id,
        status: updatedSub.status,
        currentPriceId: updatedSub.items.data[0]?.price.id,
      });

      // Update database immediately for better UX (webhook will also update, but may be delayed)
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          billingPriceId: newPlanConfig.billingPriceId,
          billingPlan: newPlan,
          billingStatus: updatedSub.status,
        },
      });

      return NextResponse.json({ success: true, message: "Upgraded immediately" });
    } else {
      // DOWNGRADE to lower paid plan: Schedule change at period end
      // First, release any existing schedule (release just detaches, cancel can affect subscription)
      if (subscription.schedule) {
        const scheduleId =
          typeof subscription.schedule === "string"
            ? subscription.schedule
            : subscription.schedule.id;
        await stripe.subscriptionSchedules.release(scheduleId);
      }

      // Create schedule for downgrade
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: workspace.billingSubscriptionId!,
      });

      await stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            items: [{ price: planItem.price.id, quantity: planItem.quantity ?? 1 }],
            start_date: schedule.phases[0].start_date,
            end_date: subscription.current_period_end,
          },
          {
            items: [{ price: newPlanConfig.billingPriceId, quantity: 1 }],
            start_date: subscription.current_period_end,
          },
        ],
      });

      return NextResponse.json({
        success: true,
        message: "Downgrade scheduled for next billing period",
      });
    }
  } catch (error) {
    console.error("Change plan error:", error);
    return NextResponse.json({ error: "Failed to change plan" }, { status: 500 });
  }
}
