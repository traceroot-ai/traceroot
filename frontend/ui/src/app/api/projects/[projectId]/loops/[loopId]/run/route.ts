import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";
import { requestLoopRun } from "@/lib/write-services/loops";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// POST /api/projects/[projectId]/loops/[loopId]/run - Run now. Inserts a pending
// manual run for the worker's next tick to enqueue.
async function handlePOST(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const result = await requestLoopRun({
    actorUserId: auth.user.id,
    projectId: auth.projectId,
    loopId: auth.loop.id,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ run: result.data }, 201);
}

export const POST = withImpersonationPolicy(handlePOST);
