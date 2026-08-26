import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { alertPauseSchema, firstIssueMessage } from "../../schema";
import { alertSelect, serializeAlert } from "../../serialize";
import { alertStateReset } from "../../rule-state";

type RouteParams = { params: Promise<{ projectId: string; alertId: string }> };

// Status only, so a pause never round-trips the rule payload it could clobber.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = alertPauseSchema.safeParse(parsed.body);
  if (!result.success) return errorResponse(firstIssueMessage(result.error), 400);
  const { status } = result.data;

  // Pausing keeps the severity it stopped at; resuming is a cold start,
  // because the gap it was paused for was never evaluated. The PAUSED guard
  // lives in the WHERE so a replayed resume of an already-active rule cannot
  // reset state it is still alerting on.
  const resumed =
    status === "ACTIVE"
      ? await prisma.alert.updateMany({
          where: { id: alertId, projectId, status: "PAUSED" },
          data: { status, ...alertStateReset() },
        })
      : { count: 0 };

  if (resumed.count === 0) {
    const { count } = await prisma.alert.updateMany({
      where: { id: alertId, projectId },
      data: { status },
    });
    if (count === 0) return errorResponse("Alert not found", 404);
  }

  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: alertSelect,
  });
  if (!alert) return errorResponse("Alert not found", 404);

  return successResponse({ alert: await serializeAlert(alert) });
}
