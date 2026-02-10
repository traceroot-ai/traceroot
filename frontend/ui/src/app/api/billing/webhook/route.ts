import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma, getStripeOrThrow, mapPriceIdToPlan } from "@traceroot/core";
import Stripe from "stripe";

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
        const subscription = event.data.object as Stripe.Subscription;
        const workspaceId = subscription.metadata.workspaceId;

        if (!workspaceId) {
          console.error("No workspaceId in subscription metadata");
          break;
        }

        const priceId = subscription.items.data[0]?.price.id;
        const plan = mapPriceIdToPlan(priceId);

        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            billingCustomerId: subscription.customer as string,
            billingSubscriptionId: subscription.id,
            billingPriceId: priceId,
            billingStatus: subscription.status, // active, past_due, canceled, etc.
            billingPlan: plan,
            billingPeriodStart: new Date(
              subscription.billing_cycle_anchor * 1000,
            ),
          },
        });

        console.log(
          `Subscription ${event.type} for workspace ${workspaceId}, priceId: ${priceId}, plan: ${plan}, status: ${subscription.status}`,
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

        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            billingSubscriptionId: null,
            billingPriceId: null,
            billingStatus: null,
            billingPlan: "free",
            billingPeriodStart: null,
          },
        });

        console.log(
          `Subscription deleted for workspace ${workspaceId}, reverted to free plan`,
        );
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
