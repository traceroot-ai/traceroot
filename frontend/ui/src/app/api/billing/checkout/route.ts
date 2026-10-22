import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { getRequestSession } from "@/lib/request-session";
import {
  prisma,
  getStripeOrThrow,
  getPlanConfig,
  PlanType,
  METERED_PRICE_ENV_VARS,
} from "@traceroot/core";

// Subscription statuses that bill now or can start billing. `incomplete` is a
// first payment still settling (for example a pending 3DS step), which becomes
// active on success, so a second checkout opened meanwhile would also bill.
// `paused` bills nothing today but is not terminal either: resuming it alongside a
// second subscription would bill the workspace twice. Only `canceled` and
// `incomplete_expired` are ends of the line, and those are absent here deliberately.
const BILLING_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

function alreadySubscribed() {
  return NextResponse.json(
    {
      error: "Workspace already has a subscription. Change the plan instead of starting checkout.",
    },
    { status: 409 },
  );
}

async function handlePOST(req: NextRequest) {
  try {
    const session = await getRequestSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, plan } = await req.json();

    // Validate plan (free plan has no checkout - users just sign up)
    const paidPlans: PlanType[] = [PlanType.STARTER, PlanType.PRO, PlanType.ENTERPRISE];
    if (!plan || !paidPlans.includes(plan)) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const planConfig = getPlanConfig(plan as PlanType);
    if (!planConfig.billingPriceId) {
      return NextResponse.json({ error: "Plan not configured" }, { status: 400 });
    }

    // Get workspace and verify access
    const workspace = await prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId: session.user.id, role: "ADMIN" } },
      },
    });
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    // A subscribed workspace changes plans through change-plan. A checkout session
    // here would add a second active subscription to the same customer, and both
    // would bill every period. With a customer on file, Stripe is asked below
    // instead, so a stored id whose cancellation webhook was missed does not block
    // a new subscription.
    if (workspace.billingSubscriptionId && !workspace.billingCustomerId) {
      return alreadySubscribed();
    }

    const stripe = getStripeOrThrow();

    // The stored subscription id can lag Stripe (a missed or delayed webhook), so
    // also ask Stripe before opening checkout for an existing customer. The list
    // uses status "all", which includes ended subscriptions, so a live one can sit
    // past the first page; iterating the list follows every page.
    if (workspace.billingCustomerId) {
      for await (const subscription of stripe.subscriptions.list({
        customer: workspace.billingCustomerId,
        status: "all",
        limit: 100,
      })) {
        if (BILLING_STATUSES.has(subscription.status)) {
          return alreadySubscribed();
        }
      }
    }

    // Create or get Stripe customer
    let customerId = workspace.billingCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: session.user.email ?? undefined,
        metadata: { workspaceId },
      });
      customerId = customer.id;
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { billingCustomerId: customerId },
      });
    }

    // Create checkout session with plan price + all three metered products.
    // Metered items have no quantity — usage flows from Stripe meter events.
    // All three are required so paid plans can be billed for chat, RCA, and
    // detector hosted-LLM usage. Missing any one means that meter's events
    // will fire successfully but no charge will appear on the customer's bill.
    const lineItems: { price: string; quantity?: number }[] = [
      { price: planConfig.billingPriceId, quantity: 1 },
    ];
    // The same list findPlanItem excludes, so a meter added there is also added here.
    for (const envName of METERED_PRICE_ENV_VARS) {
      const priceId = process.env[envName];
      if (priceId) {
        lineItems.push({ price: priceId });
      } else {
        // Loud warning so prod misconfig surfaces in logs instead of silently
        // dropping a metered line item (which means meter events fire but no
        // revenue accrues for that usage type).
        console.warn(
          `[Billing] ${envName} is not set — checkout will skip this metered price. ` +
            `Meter events for this usage type will fire but no charge will appear on the bill.`,
        );
      }
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: lineItems,
      success_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?success=true`,
      cancel_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?canceled=true`,
      metadata: { workspaceId },
      subscription_data: {
        metadata: { workspaceId },
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json({ error: "Failed to create checkout" }, { status: 500 });
  }
}
export const POST = withImpersonationPolicy(handlePOST);
