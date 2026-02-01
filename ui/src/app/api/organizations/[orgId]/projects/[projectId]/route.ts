import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteAllApiKeys } from "@/lib/api";

// Helper to check org membership
async function getOrgMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// PATCH /api/organizations/[orgId]/projects/[projectId]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; projectId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, projectId } = await params;
  const membership = await getOrgMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await request.json();
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { name: name.trim(), updated_at: new Date() },
  });

  return NextResponse.json(project);
}

// DELETE /api/organizations/[orgId]/projects/[projectId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; projectId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, projectId } = await params;
  const membership = await getOrgMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Delete API keys via Python backend first
  try {
    await deleteAllApiKeys(projectId);
  } catch (error) {
    console.error("Failed to delete API keys:", error);
  }

  // Soft delete the project
  await prisma.project.update({
    where: { id: projectId },
    data: { deleted_at: new Date() },
  });

  return NextResponse.json({ success: true });
}
