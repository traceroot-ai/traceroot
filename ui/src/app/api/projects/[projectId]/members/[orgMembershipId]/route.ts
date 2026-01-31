import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

async function getProject(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, org_id: true },
  });
}

async function getOrgMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// PATCH /api/projects/[projectId]/members/[orgMembershipId]
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; orgMembershipId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, orgMembershipId } = await params;
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Check user has admin access
  const myMembership = await getOrgMembership(session.user.id, project.org_id);
  if (!myMembership || !["OWNER", "ADMIN"].includes(myMembership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { role } = await request.json();

  // If role is null or "NONE", remove project-specific role (inherit from org)
  if (!role || role === "NONE") {
    await prisma.projectMembership.deleteMany({
      where: {
        project_id: projectId,
        org_membership_id: orgMembershipId,
      },
    });
    return NextResponse.json({ success: true, role: null });
  }

  // Validate role
  if (!["OWNER", "ADMIN", "MEMBER", "VIEWER"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Upsert project membership
  const existing = await prisma.projectMembership.findUnique({
    where: {
      project_id_org_membership_id: {
        project_id: projectId,
        org_membership_id: orgMembershipId,
      },
    },
  });

  if (existing) {
    await prisma.projectMembership.update({
      where: { id: existing.id },
      data: { role, updated_at: new Date() },
    });
  } else {
    await prisma.projectMembership.create({
      data: {
        id: randomUUID(),
        project_id: projectId,
        org_membership_id: orgMembershipId,
        role,
      },
    });
  }

  return NextResponse.json({ success: true, role });
}
