import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteAllApiKeys } from "@/lib/api";

async function getEffectiveProjectRole(
  userId: string,
  orgId: string,
  projectId: string,
): Promise<string | null> {
  const orgMembership = await prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });

  if (!orgMembership) return null;

  // Check for project-specific role override
  const projectMembership = await prisma.projectMembership.findUnique({
    where: {
      project_id_org_membership_id: {
        project_id: projectId,
        org_membership_id: orgMembership.id,
      },
    },
  });

  // Return project role if exists, otherwise org role
  return projectMembership?.role || orgMembership.role;
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
  const effectiveRole = await getEffectiveProjectRole(
    session.user.id,
    orgId,
    projectId,
  );
  if (!effectiveRole || !["OWNER", "ADMIN"].includes(effectiveRole)) {
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
  const effectiveRole = await getEffectiveProjectRole(
    session.user.id,
    orgId,
    projectId,
  );
  if (!effectiveRole || !["OWNER", "ADMIN"].includes(effectiveRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    await deleteAllApiKeys(projectId);
  } catch (error) {
    console.error("Failed to delete API keys:", error);
  }

  // Soft delete
  await prisma.project.update({
    where: { id: projectId },
    data: { deleted_at: new Date() },
  });

  return NextResponse.json({ success: true });
}
