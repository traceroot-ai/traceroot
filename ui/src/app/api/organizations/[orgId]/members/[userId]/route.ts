import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// PATCH /api/organizations/[orgId]/members/[userId] - Update member role
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, userId } = await params;
  const myMembership = await getMembership(session.user.id, orgId);
  if (!myMembership || !["OWNER", "ADMIN"].includes(myMembership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Can't change OWNER role
  const targetMembership = await getMembership(userId, orgId);
  if (!targetMembership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (targetMembership.role === "OWNER") {
    return NextResponse.json(
      { error: "Cannot change owner role" },
      { status: 403 },
    );
  }

  const { role } = await request.json();
  if (!["ADMIN", "MEMBER", "VIEWER"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const updated = await prisma.organizationMembership.update({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
    data: { role, updated_at: new Date() },
  });

  return NextResponse.json(updated);
}

// DELETE /api/organizations/[orgId]/members/[userId] - Remove member
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, userId } = await params;

  // Can remove self, or if admin/owner can remove others
  const myMembership = await getMembership(session.user.id, orgId);
  if (!myMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const isRemovingSelf = userId === session.user.id;
  const canRemoveOthers = ["OWNER", "ADMIN"].includes(myMembership.role);

  if (!isRemovingSelf && !canRemoveOthers) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Can't remove the owner
  const targetMembership = await getMembership(userId, orgId);
  if (targetMembership?.role === "OWNER") {
    return NextResponse.json({ error: "Cannot remove owner" }, { status: 403 });
  }

  await prisma.organizationMembership.delete({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });

  return NextResponse.json({ success: true });
}
