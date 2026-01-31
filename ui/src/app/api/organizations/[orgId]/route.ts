import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Helper to check membership and get role
async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// GET /api/organizations/[orgId] - Get organization with projects
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
  if (!membership) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      projects: {
        where: { deleted_at: null },
        orderBy: { created_at: "desc" },
      },
    },
  });

  if (!organization) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: organization.id,
    name: organization.name,
    role: membership.role,
    created_at: organization.created_at,
    updated_at: organization.updated_at,
    projects: organization.projects,
  });
}

// PATCH /api/organizations/[orgId] - Update organization
export async function PATCH(
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

  const { name } = await request.json();
  const organization = await prisma.organization.update({
    where: { id: orgId },
    data: { name: name.trim(), updated_at: new Date() },
  });

  return NextResponse.json(organization);
}

// DELETE /api/organizations/[orgId] - Delete organization
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership || membership.role !== "OWNER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.organization.delete({ where: { id: orgId } });
  return NextResponse.json({ success: true });
}
