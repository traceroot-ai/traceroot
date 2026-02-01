import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId] - Get project details
export async function GET(request: NextRequest, { params }: RouteParams) {
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
    access_key_count: project._count.accessKeys,
    create_time: project.createTime,
    update_time: project.updateTime,
  });
}
