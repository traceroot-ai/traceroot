import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { isRecordGone, parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { WIDGET_TITLE_MAX } from "@/features/dashboards/types";

type RouteParams = {
  params: Promise<{ projectId: string; dashboardId: string; widgetId: string }>;
};

async function findWidget(dashboardId: string, widgetId: string, projectId: string) {
  return prisma.widget.findFirst({
    where: { id: widgetId, dashboardId, dashboard: { projectId } },
  });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId, widgetId } = auth.params;

  const existing = await findWidget(dashboardId, widgetId, projectId);
  if (!existing) return errorResponse("Widget not found", 404);

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;
  const { title, spec, displayConfig } = parsed.body;

  const data: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return errorResponse("title must be a non-empty string", 400);
    }
    if (title.trim().length > WIDGET_TITLE_MAX) {
      return errorResponse(`title must be at most ${WIDGET_TITLE_MAX} characters`, 400);
    }
    data.title = title.trim();
  }
  if (spec !== undefined) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      return errorResponse("spec must be a JSON object", 400);
    }
    data.spec = spec;
  }
  if (displayConfig !== undefined) {
    if (
      displayConfig === null ||
      typeof displayConfig !== "object" ||
      Array.isArray(displayConfig)
    ) {
      return errorResponse("displayConfig must be a JSON object", 400);
    }
    data.displayConfig = displayConfig;
  }
  if (Object.keys(data).length === 0) return errorResponse("No fields to update", 400);

  try {
    const widget = await prisma.widget.update({
      where: { id: widgetId },
      data,
    });
    return successResponse({ widget });
  } catch (e) {
    // Deleted concurrently between the scoped findFirst and this write.
    if (isRecordGone(e)) return errorResponse("Widget not found", 404);
    throw e;
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId, widgetId } = auth.params;

  const existing = await findWidget(dashboardId, widgetId, projectId);
  if (!existing) return errorResponse("Widget not found", 404);

  try {
    await prisma.widget.delete({ where: { id: widgetId } });
  } catch (e) {
    // Deleted concurrently between the scoped findFirst and this write.
    if (isRecordGone(e)) return errorResponse("Widget not found", 404);
    throw e;
  }
  return successResponse({ deleted: true });
}
