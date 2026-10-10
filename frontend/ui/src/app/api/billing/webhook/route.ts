import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma, getStripeOrThrow, PlanType } from "@traceroot/core";
import Stripe from "stripe";
import { workspaceBillingFromSubscription } from "../workspace-billing";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("stripe-signature");

  if (!signature || !process.env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = getStripeOrThrow();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SIGNING_SECRET,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Handles: new subscription, plan changes, payment status changes
        // Stripe auto-updates subscription.status on payment success/failure
        let subscription = event.data.object as Stripe.Subscription;
        const workspaceId = subscription.metadata.workspaceId;

        if (!workspaceId) {
          console.error("No workspaceId in subscription metadata");
          break;
        }

        // If billing period dates are missing, fetch full subscription from Stripe
        if (!subscription.current_period_start || !subscription.current_period_end) {
          console.log(
            `Billing period missing in webhook, fetching subscription ${subscription.id}`,
          );
          subscription = await stripe.subscriptions.retrieve(subscription.id);
        }

        const billing = workspaceBillingFromSubscription(subscription);
        const plan = billing.billingPlan;

        // updateMany rather than update: a workspace that no longer exists must not
        // throw. See the `count === 0` branch below.
        const { count } = await prisma.workspace.updateMany({
          where: { id: workspaceId },
          data: billing,
        });

        if (count === 0) {
          console.warn(
            `Webhook ${event.type}: workspace ${workspaceId} not found (subscription ${subscription.id}) — acknowledging so Stripe stops retrying`,
          );
          break;
        }

        console.log(
          `Subscription ${event.type} for workspace ${workspaceId}, plan: ${plan}, status: ${subscription.status}, period: ${subscription.current_period_start} - ${subscription.current_period_end}`,
        );
        break;
      }

      case "customer.subscription.deleted": {
        // Subscription ended (cancelled, expired, etc.)
        const subscription = event.data.object as Stripe.Subscription;
        const workspaceId = subscription.metadata.workspaceId;

        if (!workspaceId) {
          console.error("No workspaceId in subscription metadata");
          break;
        }

        const { count } = await prisma.workspace.updateMany({
          where: { id: workspaceId },
          data: {
            billingSubscriptionId: null,
            billingPriceId: null,
            billingStatus: null,
            billingPlan: PlanType.FREE,
            billingPeriodStart: null,
            billingPeriodEnd: null,
          },
        });

        if (count === 0) {
          console.warn(
            `Webhook ${event.type}: workspace ${workspaceId} not found (subscription ${subscription.id}) — acknowledging so Stripe stops retrying`,
          );
          break;
        }

        console.log(`Subscription deleted for workspace ${workspaceId}, reverted to free plan`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json({ error: "Webhook failed" }, { status: 500 });
  }
}
