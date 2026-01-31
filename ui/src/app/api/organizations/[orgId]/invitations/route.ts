import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// GET /api/organizations/[orgId]/invitations
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const invitations = await prisma.membershipInvitation.findMany({
    where: { org_id: orgId },
    orderBy: { created_at: "desc" },
  });

  return NextResponse.json({ data: invitations });
}

// POST /api/organizations/[orgId]/invitations
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { email, role } = await request.json();
  if (!email?.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!["ADMIN", "MEMBER", "VIEWER"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Check if user already exists and is a member
  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (existingUser) {
    const existingMembership = await getMembership(existingUser.id, orgId);
    if (existingMembership) {
      return NextResponse.json(
        { error: "User is already a member" },
        { status: 400 },
      );
    }
  }

  // Check if invitation already exists
  const existingInvitation = await prisma.membershipInvitation.findUnique({
    where: { email_org_id: { email: email.toLowerCase(), org_id: orgId } },
  });
  if (existingInvitation) {
    return NextResponse.json(
      { error: "Invitation already sent" },
      { status: 400 },
    );
  }

  const invitation = await prisma.membershipInvitation.create({
    data: {
      id: randomUUID(),
      email: email.toLowerCase(),
      org_id: orgId,
      org_role: role,
      invited_by_user_id: session.user.id,
    },
  });

  return NextResponse.json(invitation);
}
