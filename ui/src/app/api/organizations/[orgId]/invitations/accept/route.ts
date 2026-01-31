import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

// POST /api/invitations/accept - Accept pending invitations for current user
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find all pending invitations for this email
  const invitations = await prisma.membershipInvitation.findMany({
    where: { email: session.user.email.toLowerCase() },
  });

  // Create memberships and delete invitations
  for (const inv of invitations) {
    await prisma.organizationMembership.create({
      data: {
        id: randomUUID(),
        org_id: inv.org_id,
        user_id: session.user.id,
        role: inv.org_role,
      },
    });
    await prisma.membershipInvitation.delete({ where: { id: inv.id } });
  }

  return NextResponse.json({ accepted: invitations.length });
}
