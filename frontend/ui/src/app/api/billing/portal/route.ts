import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, getStripeOrThrow } from "@traceroot/core";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
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
      return_url: `${process.env.NEXTAUTH_URL}/workspaces/${workspaceId}/settings/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("Portal error:", error);
    return NextResponse.json({ error: "Failed to create portal" }, { status: 500 });
  }
}
