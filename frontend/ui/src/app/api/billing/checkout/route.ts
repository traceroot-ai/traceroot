import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma, getStripeOrThrow, getPlanConfig, PlanType } from "@traceroot/core";

// Subscription statuses that bill now or can start billing. `incomplete` is a
// first payment still settling (for example a pending 3DS step), which becomes
// active on success, so a second checkout opened meanwhile would also bill.
const BILLING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

function alreadySubscribed() {
  return NextResponse.json(
    {
      error: "Workspace already has a subscription. Change the plan instead of starting checkout.",
    },
    { status: 409 },
  );
}

type Stripe = ReturnType<typeof getStripeOrThrow>;

// A simultaneous request may have expired the same session first; that is fine as
// long as it is no longer open.
async function expireCheckoutSession(stripe: Stripe, sessionId: string) {
  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch (error) {
    const current = await stripe.checkout.sessions.retrieve(sessionId);
    if (current.status === "open") throw error;
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
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
    const expiredSessionIds: string[] = [];

    // The stored subscription id can lag Stripe (a missed or delayed webhook), so
    // also ask Stripe before opening checkout for an existing customer.
    if (workspace.billingCustomerId) {
      // status "all" includes ended subscriptions, so a live one can sit past the
      // first page; iterating the list follows every page.
      for await (const subscription of stripe.subscriptions.list({
        customer: workspace.billingCustomerId,
        status: "all",
        limit: 100,
      })) {
        if (BILLING_STATUSES.has(subscription.status)) {
          return alreadySubscribed();
        }
      }

      // Stripe creates the subscription only when a session completes, so two open
      // sessions for one workspace could each become a subscription. Keep one open
      // session for the same plan (a double submit or a retry) and expire every other
      // one, including extra same-plan sessions, before returning or opening a new one.
      let reusableUrl: string | null = null;
      for await (const openSession of stripe.checkout.sessions.list({
        customer: workspace.billingCustomerId,
        status: "open",
        limit: 100,
      })) {
        if (openSession.metadata?.workspaceId !== workspaceId) continue;
        if (!reusableUrl && openSession.metadata?.plan === plan && openSession.url) {
          reusableUrl = openSession.url;
          continue;
        }
        await expireCheckoutSession(stripe, openSession.id);
        expiredSessionIds.push(openSession.id);
      }
      if (reusableUrl) {
        return NextResponse.json({ url: reusableUrl });
      }
    }

    // Create or get Stripe customer
    let customerId = workspace.billingCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: session.user.email ?? undefined,
        metadata: { workspaceId },
      });
      // Two admins can start checkout for a new workspace at the same time. Only the
      // first customer is stored; a request that loses the race deletes its own and
      // continues with the stored one, so both reach the same checkout below.
      const claimed = await prisma.workspace.updateMany({
        where: { id: workspaceId, billingCustomerId: null },
        data: { billingCustomerId: customer.id },
      });
      if (claimed.count === 1) {
        customerId = customer.id;
      } else {
        await stripe.customers.del(customer.id).catch((error: unknown) => {
          console.warn(`[Billing] Failed to delete unused customer ${customer.id}:`, error);
        });
        const stored = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { billingCustomerId: true },
        });
        if (!stored?.billingCustomerId) {
          throw new Error(`Workspace ${workspaceId} has no billing customer`);
        }
        customerId = stored.billingCustomerId;
      }
    }

    // Requests that arrive together see no open session yet. The same idempotency key
    // makes Stripe return one session to all of them. Sessions this request expired
    // are part of the key: otherwise a retry within the window would get back the
    // cached response for a session that is no longer open.
    const idempotencyWindow = Math.floor(Date.now() / 60_000);
    const expiredDigest = expiredSessionIds.length
      ? `-${createHash("sha256").update(expiredSessionIds.join(",")).digest("hex").slice(0, 16)}`
      : "";

    // Create checkout session with plan price + all three metered products.
    // Metered items have no quantity — usage flows from Stripe meter events.
    // All three are required so paid plans can be billed for chat, RCA, and
    // detector hosted-LLM usage. Missing any one means that meter's events
    // will fire successfully but no charge will appear on the customer's bill.
    const lineItems: { price: string; quantity?: number }[] = [
      { price: planConfig.billingPriceId, quantity: 1 },
    ];
    const meteredPriceIds: Array<[string, string | undefined]> = [
      ["STRIPE_PRICE_ID_AI_USAGE", process.env.STRIPE_PRICE_ID_AI_USAGE],
      ["STRIPE_PRICE_ID_RCA_USAGE", process.env.STRIPE_PRICE_ID_RCA_USAGE],
      ["STRIPE_PRICE_ID_DETECTOR_USAGE", process.env.STRIPE_PRICE_ID_DETECTOR_USAGE],
    ];
    for (const [envName, priceId] of meteredPriceIds) {
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

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        line_items: lineItems,
        success_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?success=true`,
        cancel_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?canceled=true`,
        metadata: { workspaceId, plan },
        subscription_data: {
          metadata: { workspaceId },
        },
      },
      {
        idempotencyKey: `workspace-checkout-${workspaceId}-${plan}-${idempotencyWindow}${expiredDigest}`,
      },
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json({ error: "Failed to create checkout" }, { status: 500 });
  }
}
