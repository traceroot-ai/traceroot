import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// DELETE /api/organizations/[orgId]/invitations/[invitationId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; invitationId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, invitationId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.membershipInvitation.delete({
    where: { id: invitationId },
  });

  return NextResponse.json({ success: true });
}
