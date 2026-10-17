import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, readDeleteReason, requireProjectAuth } from "@/lib/route-helpers";
import { deleteWidget, updateWidget } from "@/lib/write-services/dashboards";

type RouteParams = {
  params: Promise<{ projectId: string; dashboardId: string; widgetId: string }>;
};

// Thin adapters over the write service, which owns the validation (the spec
// is checked against the stored type, as on create), the tenancy scoping
// through the dashboard's project, the diff and the audit row. The nested
// dashboard id is passed along so a widget under the wrong dashboard path
// stays a 404.

async function handlePATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId, widgetId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await updateWidget({
    actorUserId: auth.user.id,
    projectId,
    dashboardId,
    widgetId,
    patch: parsed.body,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ widget: result.data });
}

async function handleDELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId, widgetId } = auth.params;

  const result = await deleteWidget({
    actorUserId: auth.user.id,
    projectId,
    dashboardId,
    widgetId,
    reason: await readDeleteReason(req),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ deleted: true });
}
export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
