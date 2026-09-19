import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, readDeleteReason, requireProjectAuth } from "@/lib/route-helpers";
import { deleteDashboard, updateDashboard } from "@/lib/write-services/dashboards";

type RouteParams = { params: Promise<{ projectId: string; dashboardId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
    include: { widgets: { orderBy: { createTime: "asc" } } },
  });
  if (!dashboard) return errorResponse("Dashboard not found", 404);
  return successResponse({ dashboard });
}

// Thin adapters over the write service, which owns the validation (layout
// entries included: the drag interaction only ever reaches the service from
// here), the last-dashboard refusal, the diff and the audit row.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  // Parse the body before hitting the DB — fail fast on bad input.
  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await updateDashboard({
    actorUserId: auth.user.id,
    projectId,
    dashboardId,
    patch: parsed.body,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ dashboard: result.data });
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const result = await deleteDashboard({
    actorUserId: auth.user.id,
    projectId,
    dashboardId,
    reason: await readDeleteReason(req),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ deleted: true });
}
