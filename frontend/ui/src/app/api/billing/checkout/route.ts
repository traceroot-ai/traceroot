import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, getStripeOrThrow, getPlanConfig, PlanType } from "@traceroot/core";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, plan } = await req.json();

    // Validate plan (free plan has no checkout - users just sign up)
    const paidPlans: PlanType[] = [PlanType.STARTER, PlanType.PRO, PlanType.STARTUPS];
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

    const stripe = getStripeOrThrow();

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

    // Create checkout session with tiered price (includes base + usage)
    // Quantity represents total events, Stripe calculates tiered pricing automatically
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: planConfig.billingPriceId, quantity: 1 }],
      success_url: `${process.env.NEXTAUTH_URL}/workspaces/${workspaceId}/settings/billing?success=true`,
      cancel_url: `${process.env.NEXTAUTH_URL}/workspaces/${workspaceId}/settings/billing?canceled=true`,
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
