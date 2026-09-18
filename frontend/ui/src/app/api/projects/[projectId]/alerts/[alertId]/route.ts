import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, readDeleteReason, requireProjectAuth } from "@/lib/route-helpers";
import { deleteAlert, updateAlert } from "@/lib/write-services/alerts";
import { alertSelect, serializeAlert } from "../serialize";

type RouteParams = { params: Promise<{ projectId: string; alertId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: alertSelect,
  });
  if (!alert) return errorResponse("Alert not found", 404);

  return successResponse({ alert: await serializeAlert(alert) });
}

// Thin adapters over the write service, which owns the merged-rule
// validation, the cold start on a rule change, the parked re-arm, the diff
// and the audit row.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await updateAlert({
    actorUserId: auth.user.id,
    projectId,
    alertId,
    patch: parsed.body,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ alert: result.data });
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const result = await deleteAlert({
    actorUserId: auth.user.id,
    projectId,
    alertId,
    reason: await readDeleteReason(req),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ success: true });
}
