import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { getRequestSession } from "@/lib/request-session";
import { prisma, getStripeOrThrow } from "@traceroot/core";

async function handlePOST(req: NextRequest) {
  try {
    const session = await getRequestSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId } = await req.json();

    const workspace = await prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId: session.user.id, role: "ADMIN" } },
      },
    });
    if (!workspace?.billingCustomerId) {
      return NextResponse.json({ error: "No billing account" }, { status: 404 });
    }

    const stripe = getStripeOrThrow();

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: workspace.billingCustomerId,
      return_url: `${process.env.BETTER_AUTH_URL}/workspaces/${workspaceId}/settings/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("Portal error:", error);
    return NextResponse.json({ error: "Failed to create portal" }, { status: 500 });
  }
}
export const POST = withImpersonationPolicy(handlePOST);
