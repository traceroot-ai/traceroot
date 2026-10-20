import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { isDemoWorkspace, sortDemoLast, userMembershipWhere } from "@/lib/demo-workspace";

const createWorkspaceSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
});

// GET /api/workspaces - List workspaces the user belongs to
async function handleGET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const memberships = await prisma.workspaceMember.findMany({
    where: userMembershipWhere(user.id, "include-demo"),
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

  // The demo workspace comes last and is marked, so the UI never treats it as
  // the user's own. Its member count is every user, so it is not shown.
  const workspaces = sortDemoLast(memberships, (m) => m.workspace.id).map((m) => {
    const isDemo = isDemoWorkspace(m.workspace.id);
    return {
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      is_demo: isDemo,
      member_count: isDemo ? undefined : m.workspace._count.members,
      project_count: m.workspace.projects.length,
      projects: m.workspace.projects,
      create_time: m.workspace.createTime,
    };
  });

  return successResponse({ workspaces });
}

// POST /api/workspaces - Create a new workspace
async function handlePOST(request: NextRequest) {
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

  // Create workspace and owner membership in a transaction. No duplicate
  // pre-check: uq_workspace_created_by_name is the check, and the only
  // race-free one.
  let workspace;
  try {
    workspace = await prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          id: workspaceId,
          name,
          createdBy: user.id,
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
  } catch (e) {
    if (!isPrismaKnownError(e, "P2002")) throw e;
    return errorResponse("A workspace with this name already exists", 409);
  }

  return NextResponse.json(
    {
      id: workspace.id,
      name: workspace.name,
      role: Role.ADMIN,
      is_demo: false,
      member_count: 1,
      project_count: 0,
      projects: [],
      create_time: workspace.createTime,
    },
    { status: 201 },
  );
}
export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
