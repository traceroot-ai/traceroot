import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma, getStripeOrThrow } from "@traceroot/core";
import { workspaceBillingFromSubscription } from "../../workspace-billing";

const PAID_STATUSES = new Set(["paid", "no_payment_required"]);
// A paid checkout produces an active or trialing subscription. Anything else means
// the subscription has since ended or changed, and the webhook owns that state.
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * Sync a workspace's subscription from Stripe when Checkout redirects back.
 *
 * Without this the webhook is the only writer of the billing columns for a new
 * subscription. While it is delayed or failing the customer has paid but the
 * workspace still reads as Free, and retrying the upgrade opens another checkout.
 * The webhook stays the eventual backstop; both derive the same columns from the
 * same Stripe subscription.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, sessionId } = await req.json();
    if (typeof workspaceId !== "string" || typeof sessionId !== "string" || !sessionId) {
      return NextResponse.json(
        { error: "workspaceId and sessionId are required" },
        { status: 400 },
      );
    }

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
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    // The session id comes from the URL, so it must belong to this workspace.
    if (checkoutSession.metadata?.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "Checkout session not found" }, { status: 404 });
    }

    // A session can be complete while an asynchronous payment (SEPA debit, for
    // example) is still processing. Leave those to the webhook rather than grant the
    // plan before the money arrives.
    if (
      checkoutSession.status !== "complete" ||
      !checkoutSession.subscription ||
      !PAID_STATUSES.has(checkoutSession.payment_status)
    ) {
      return NextResponse.json({ reconciled: false });
    }

    const subscription =
      typeof checkoutSession.subscription === "string"
        ? await stripe.subscriptions.retrieve(checkoutSession.subscription)
        : checkoutSession.subscription;

    if (subscription.metadata?.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "Checkout session not found" }, { status: 404 });
    }

    // The success link can be revisited after the subscription was canceled. Writing
    // it then would put the workspace back on the paid plan without a payment.
    if (!LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      return NextResponse.json({ reconciled: false });
    }

    const billing = workspaceBillingFromSubscription(subscription);
    // Only fill in a workspace that has no subscription yet or is already on this
    // one. A revisited success link, or a checkout that lost a race to another,
    // must not replace the subscription the workspace is actually on.
    const { count } = await prisma.workspace.updateMany({
      where: {
        id: workspaceId,
        OR: [{ billingSubscriptionId: null }, { billingSubscriptionId: subscription.id }],
      },
      data: billing,
    });
    if (count === 0) {
      return NextResponse.json({ reconciled: false });
    }

    return NextResponse.json({ reconciled: true, plan: billing.billingPlan });
  } catch (error) {
    console.error("Checkout reconcile error:", error);
    return NextResponse.json({ error: "Failed to reconcile checkout" }, { status: 500 });
  }
}
