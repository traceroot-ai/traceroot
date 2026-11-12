import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { Role } from "@traceroot/core";
import { loopStatusActionSchema } from "@traceroot/core/loops/pure";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { setLoopStatus } from "@/lib/write-services/loops";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// POST /api/projects/[projectId]/loops/[loopId]/status - Pause or resume: { action }
async function handlePOST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;
  const action = loopStatusActionSchema.safeParse(parsed.body);
  if (!action.success) return errorResponse(action.error.issues[0].message, 400);

  const result = await setLoopStatus({
    actorUserId: auth.user.id,
    projectId: auth.params.projectId,
    loopId: auth.params.loopId,
    action: action.data.action,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ loop: result.data });
}

export const POST = withImpersonationPolicy(handlePOST);
