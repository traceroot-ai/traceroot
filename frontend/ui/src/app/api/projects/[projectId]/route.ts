import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { projectDetailsResponse } from "@/lib/project-response";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId] - Get project details
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const readAt = new Date().toISOString();
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
    ...projectDetailsResponse(project, accessResult.membership.role),
    read_at: readAt,
    workspace_id: project.workspaceId,
    access_key_count: project._count.accessKeys,
  });
}
export const GET = withImpersonationPolicy(handleGET);
