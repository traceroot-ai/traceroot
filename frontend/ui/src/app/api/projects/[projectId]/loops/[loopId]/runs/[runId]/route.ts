import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { getLoopRun } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireProjectAuth } from "@/lib/route-helpers";

type RouteParams = { params: Promise<{ projectId: string; loopId: string; runId: string }> };

// GET /api/projects/[projectId]/loops/[loopId]/runs/[runId] - One run
async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, loopId, runId } = auth.params;

  const loop = await prisma.loop.findFirst({
    where: { id: loopId, projectId },
    select: { id: true },
  });
  if (!loop) return errorResponse("Loop not found", 404);
  const run = await getLoopRun(prisma, loopId, runId);
  if (!run) return errorResponse("Run not found", 404);
  return successResponse({ run });
}

export const GET = withImpersonationPolicy(handleGET);
