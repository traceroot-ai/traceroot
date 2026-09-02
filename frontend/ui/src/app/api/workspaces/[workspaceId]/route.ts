import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";

const updateWorkspaceSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId] - Get workspace details with projects
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;
  const { membership } = membershipResult;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      projects: {
        where: { deleteTime: null },
        orderBy: { name: "asc" },
        include: {
          _count: { select: { accessKeys: true } },
        },
      },
      _count: {
        select: { members: true },
      },
    },
  });

  if (!workspace) {
    return errorResponse("Workspace not found", 404);
  }

  return successResponse({
    id: workspace.id,
    name: workspace.name,
    role: membership.role,
    member_count: workspace._count.members,
    projects: workspace.projects.map((p) => ({
      id: p.id,
      name: p.name,
      trace_ttl_days: p.traceTtlDays,
      access_key_count: p._count.accessKeys,
      create_time: p.createTime,
    })),
    create_time: workspace.createTime,
    // Billing fields
    billingPlan: workspace.billingPlan,
    billingCustomerId: workspace.billingCustomerId,
    billingSubscriptionId: workspace.billingSubscriptionId,
    billingStatus: workspace.billingStatus,
    currentUsage: workspace.currentUsage,
  });
}

// PUT /api/workspaces/[workspaceId] - Update workspace (ADMIN+)
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = updateWorkspaceSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name } = result.data;

  let workspace;
  try {
    workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        name,
        updateTime: new Date(),
      },
    });
  } catch (e) {
    // The creator already has another workspace by this name
    // (uq_workspace_created_by_name).
    if (!isPrismaKnownError(e, "P2002")) throw e;
    return errorResponse("A workspace with this name already exists", 409);
  }

  return successResponse({
    id: workspace.id,
    name: workspace.name,
    update_time: workspace.updateTime,
  });
}

// DELETE /api/workspaces/[workspaceId] - Delete workspace (ADMIN only)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  // Delete workspace (cascades to projects, memberships, invites, access keys)
  await prisma.workspace.delete({
    where: { id: workspaceId },
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
