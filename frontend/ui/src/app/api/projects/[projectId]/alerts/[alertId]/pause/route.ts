import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { setAlertStatus } from "@/lib/write-services/alerts";

type RouteParams = { params: Promise<{ projectId: string; alertId: string }> };

// Status only, so a pause never round-trips the rule payload it could clobber.
// A thin adapter over the write service, which owns the settable statuses,
// the transition rules and the audit row.
async function handlePATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await setAlertStatus({
    actorUserId: auth.user.id,
    projectId,
    alertId,
    status: parsed.body.status,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ alert: result.data });
}
export const PATCH = withImpersonationPolicy(handlePATCH);
