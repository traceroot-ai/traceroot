import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";

const createWorkspaceSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
});

// GET /api/workspaces - List workspaces the user belongs to
export async function GET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    include: {
      workspace: {
        include: {
          projects: {
            where: { deleteTime: null },
            select: { id: true, name: true },
          },
          _count: {
            select: { members: true },
          },
        },
      },
    },
    orderBy: { workspace: { name: "asc" } },
  });

  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    member_count: m.workspace._count.members,
    project_count: m.workspace.projects.length,
    projects: m.workspace.projects,
    create_time: m.workspace.createTime,
  }));

  return successResponse({ workspaces });
}

// POST /api/workspaces - Create a new workspace
export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = createWorkspaceSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name } = result.data;
  const workspaceId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();

  // Create workspace and owner membership in a transaction
  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        id: workspaceId,
        name,
      },
    });

    await tx.workspaceMember.create({
      data: {
        id: membershipId,
        workspaceId,
        userId: user.id,
        role: Role.ADMIN,
      },
    });

    return ws;
  });

  return NextResponse.json(
    {
      id: workspace.id,
      name: workspace.name,
      role: Role.ADMIN,
      member_count: 1,
      project_count: 0,
      projects: [],
      create_time: workspace.createTime,
    },
    { status: 201 },
  );
}
