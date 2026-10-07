import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isPlainObject } from "@/lib/is-plain-object";
import { UI_DELETE_REASON, readJsonObject } from "@/lib/route-helpers";
import { deleteWorkspace, updateWorkspace } from "@/lib/write-services/workspaces";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId] - Get workspace details with projects
async function handleGET(request: NextRequest, { params }: RouteParams) {
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
// Still a PUT for the web app, but a thin adapter over the write service,
// which owns the validation, the ADMIN floor, the diff and the audit row.
async function handlePUT(request: NextRequest, { params }: RouteParams) {
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
  const name = isPlainObject(body) ? body.name : undefined;

  const result = await updateWorkspace({
    actorUserId: user.id,
    workspaceId,
    patch: { name } as { name?: string },
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);

  return successResponse({
    id: result.data.id,
    name: result.data.name,
    update_time: result.data.updateTime,
  });
}

// DELETE /api/workspaces/[workspaceId] - Delete workspace (ADMIN only)
// The service requires the workspace's name as a typed confirmation. The web
// app's dialog is the confirmation step on this surface and sends no body
// today, so a missing name is filled in from the row; a body carrying
// `name` (and `reason`) is honored when one arrives.
async function handleDELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  const body = await readJsonObject(request);
  let name = typeof body.name === "string" ? body.name : undefined;
  if (name === undefined) {
    const current = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    if (!current) return errorResponse("Workspace not found", 404);
    name = current.name;
  }

  const result = await deleteWorkspace({
    actorUserId: user.id,
    workspaceId,
    name,
    reason: typeof body.reason === "string" ? body.reason : UI_DELETE_REASON,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);

  return NextResponse.json({ deleted: true }, { status: 200 });
}
export const GET = withImpersonationPolicy(handleGET);
export const PUT = withImpersonationPolicy(handlePUT);
export const DELETE = withImpersonationPolicy(handleDELETE);
