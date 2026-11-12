import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireProjectAuth } from "@/lib/route-helpers";
import { requestLoopRun } from "@/lib/write-services/loops";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// POST /api/projects/[projectId]/loops/[loopId]/run - Run now. Inserts a pending
// manual run; the worker's next tick enqueues it, so until a worker runs it the
// run stays queued.
async function handlePOST(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const result = await requestLoopRun({
    actorUserId: auth.user.id,
    projectId: auth.params.projectId,
    loopId: auth.params.loopId,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ run: result.data }, 201);
}

export const POST = withImpersonationPolicy(handlePOST);
