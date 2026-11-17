import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { getRequestSession } from "@/lib/request-session";
import {
  prisma,
  getStripeOrThrow,
  getPlanConfig,
  PlanType,
  METERED_PRICE_ENV_VARS,
  normalizePromoCode,
  resolvePromoForPlan,
  promoFailureFromStripeError,
} from "@traceroot/core";

async function handlePOST(req: NextRequest) {
  try {
    const session = await getRequestSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, plan, promoCode } = await req.json();

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

    const stripe = getStripeOrThrow();

    // Optional promo code. Resolved before any Stripe customer or session exists,
    // so a rejected code leaves nothing behind. The code must belong to this plan.
    // Checkout gets the resolved code via `discounts` (the promo-code box stays off,
    // so a code cannot be typed in past the plan check).
    let promotionCodeId: string | null = null;
    const code = normalizePromoCode(promoCode);
    if (code) {
      const resolution = await resolvePromoForPlan(stripe, code, plan);
      if (!resolution.ok) {
        return NextResponse.json(
          { error: resolution.message, reason: resolution.reason },
          { status: 400 },
        );
      }
      promotionCodeId = resolution.promotionCodeId;
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
      ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
      success_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?success=true`,
      cancel_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing?canceled=true`,
      metadata: { workspaceId },
      subscription_data: {
        metadata: { workspaceId },
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    // Stripe checks the code's own restrictions (e.g. first-time customers only) when
    // the session is created, so a refusal surfaces here.
    const promoFailure = promoFailureFromStripeError(error);
    if (promoFailure) {
      return NextResponse.json(
        { error: promoFailure.message, reason: promoFailure.reason },
        { status: 400 },
      );
    }
    console.error("Checkout error:", error);
    return NextResponse.json({ error: "Failed to create checkout" }, { status: 500 });
  }
}
export const POST = withImpersonationPolicy(handlePOST);
