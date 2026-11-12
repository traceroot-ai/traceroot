import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { listLoopFindings } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireProjectAuth } from "@/lib/route-helpers";
import { readPaging } from "../../page-params";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// GET /api/projects/[projectId]/loops/[loopId]/findings - The signals this Loop
// created (signals of its hidden detector), most recently seen first.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, loopId } = auth.params;

  const loop = await prisma.loop.findFirst({
    where: { id: loopId, projectId },
    select: { detectorId: true },
  });
  if (!loop) return errorResponse("Loop not found", 404);

  const { page, limit } = readPaging(req);
  return successResponse(
    await listLoopFindings(prisma, { detectorId: loop.detectorId, projectId, page, limit }),
  );
}

export const GET = withImpersonationPolicy(handleGET);
