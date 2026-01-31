import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

// Helper: Get project with org_id
async function getProject(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, org_id: true },
  });
}

// Helper: Get user's org membership
async function getOrgMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// GET /api/projects/[projectId]/members
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Check user has access to org
  const myMembership = await getOrgMembership(session.user.id, project.org_id);
  if (!myMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get all org members with their project-specific roles
  const orgMemberships = await prisma.organizationMembership.findMany({
    where: { org_id: project.org_id },
    include: {
      user: {
        select: { id: true, email: true, name: true, image: true },
      },
      projectMemberships: {
        where: { project_id: projectId },
      },
    },
    orderBy: { created_at: "asc" },
  });

  const members = orgMemberships.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    org_role: m.role,
    project_role: m.projectMemberships[0]?.role || null, // null = inherits org role
    project_membership_id: m.projectMemberships[0]?.id || null,
    created_at: m.created_at,
  }));

  return NextResponse.json({ data: members });
}
