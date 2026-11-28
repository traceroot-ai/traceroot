import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { getLoopRun } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";

type RouteParams = { params: Promise<{ projectId: string; loopId: string; runId: string }> };

// GET /api/projects/[projectId]/loops/[loopId]/runs/[runId] - One run
async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params);
  if (auth.error) return auth.error;

  const run = await getLoopRun(prisma, auth.loop.id, auth.params.runId);
  if (!run) return errorResponse("Run not found", 404);
  return successResponse({ run });
}

export const GET = withImpersonationPolicy(handleGET);
