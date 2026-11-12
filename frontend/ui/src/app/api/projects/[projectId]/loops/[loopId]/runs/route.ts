import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { listLoopRuns } from "@traceroot/core/loops";
import { LOOP_RUN_STATUSES, type LoopRunStatus } from "@traceroot/core/loops/pure";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireProjectAuth } from "@/lib/route-helpers";
import { readPaging } from "../../page-params";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// GET /api/projects/[projectId]/loops/[loopId]/runs - Runs, newest first.
// Optional `status` narrows to one outcome.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, loopId } = auth.params;

  const loop = await prisma.loop.findFirst({
    where: { id: loopId, projectId },
    select: { id: true },
  });
  if (!loop) return errorResponse("Loop not found", 404);

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !(LOOP_RUN_STATUSES as readonly string[]).includes(status)) {
    return errorResponse(`status must be one of: ${LOOP_RUN_STATUSES.join(", ")}`, 400);
  }
  const { page, limit } = readPaging(req);
  return successResponse(
    await listLoopRuns(prisma, { loopId, page, limit, status: status as LoopRunStatus | null }),
  );
}

export const GET = withImpersonationPolicy(handleGET);
