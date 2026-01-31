import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

// POST /api/invitations/[invitationId] - accept or decline
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { invitationId } = await params;
  const { accept } = await request.json();

  const invitation = await prisma.membershipInvitation.findUnique({
    where: { id: invitationId },
  });

  if (!invitation || invitation.email !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (accept) {
    // Create membership
    await prisma.organizationMembership.create({
      data: {
        id: randomUUID(),
        org_id: invitation.org_id,
        user_id: session.user.id,
        role: invitation.org_role,
      },
    });
  }

  // Delete invitation either way
  await prisma.membershipInvitation.delete({ where: { id: invitationId } });

  return NextResponse.json({ success: true, accepted: accept });
}
