import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, DEFAULT_ALERT_WINDOW } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isDemoViewer } from "@/lib/demo-workspace";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId] - Get project details
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      deleteTime: null,
    },
    include: {
      _count: { select: { accessKeys: true } },
      alertConfig: true,
    },
  });

  if (!project) {
    return errorResponse("Project not found", 404);
  }

  return successResponse({
    id: project.id,
    workspace_id: project.workspaceId,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    rca_model: project.rcaModel,
    rca_provider: project.rcaProvider,
    rca_source: project.rcaSource,
    // Alert recipients are team emails; demo viewers do not get them.
    alert_emails: isDemoViewer(project.workspaceId, accessResult.membership.role)
      ? []
      : (project.alertConfig?.emailAddresses ?? []),
    alert_window: project.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW,
    access_key_count: project._count.accessKeys,
    create_time: project.createTime,
    update_time: project.updateTime,
  });
}
export const GET = withImpersonationPolicy(handleGET);
