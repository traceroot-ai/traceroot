import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma, getStripeOrThrow } from "@traceroot/core";
import { workspaceBillingFromSubscription } from "../../workspace-billing";

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

    if (checkoutSession.status !== "complete" || !checkoutSession.subscription) {
      return NextResponse.json({ reconciled: false });
    }

    const subscription =
      typeof checkoutSession.subscription === "string"
        ? await stripe.subscriptions.retrieve(checkoutSession.subscription)
        : checkoutSession.subscription;

    if (subscription.metadata?.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "Checkout session not found" }, { status: 404 });
    }

    const billing = workspaceBillingFromSubscription(subscription);
    await prisma.workspace.update({ where: { id: workspaceId }, data: billing });

    return NextResponse.json({ reconciled: true, plan: billing.billingPlan });
  } catch (error) {
    console.error("Checkout reconcile error:", error);
    return NextResponse.json({ error: "Failed to reconcile checkout" }, { status: 500 });
  }
}
