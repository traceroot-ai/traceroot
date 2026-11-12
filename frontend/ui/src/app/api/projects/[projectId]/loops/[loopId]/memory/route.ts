import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { listMemory } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireProjectAuth } from "@/lib/route-helpers";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// GET /api/projects/[projectId]/loops/[loopId]/memory - The project's Loop
// memory (shared by all its Loops; `loopId` on a note is the Loop that wrote it).
// Expired notes are hidden unless `include_expired=true`.
async function handleGET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, loopId } = auth.params;

  const loop = await prisma.loop.findFirst({
    where: { id: loopId, projectId },
    select: { id: true },
  });
  if (!loop) return errorResponse("Loop not found", 404);

  const memories = await listMemory(prisma, {
    projectId,
    now: new Date(),
    includeExpired: req.nextUrl.searchParams.get("include_expired") === "true",
  });
  return successResponse({ data: memories });
}

export const GET = withImpersonationPolicy(handleGET);
