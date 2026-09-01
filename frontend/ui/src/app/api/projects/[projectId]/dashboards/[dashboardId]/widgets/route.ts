import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { createWidgetWithPlacement } from "@/lib/dashboard-layout";
import { isWidgetType, WIDGET_TITLE_MAX, WIDGET_TYPES } from "@/features/dashboards/types";

type RouteParams = { params: Promise<{ projectId: string; dashboardId: string }> };

// POST .../widgets — add a widget to a dashboard
export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
  });
  if (!dashboard) return errorResponse("Dashboard not found", 404);

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;
  const { title, type, spec, displayConfig } = parsed.body;

  if (typeof title !== "string" || title.trim().length === 0) {
    return errorResponse("title must be a non-empty string", 400);
  }
  if (title.trim().length > WIDGET_TITLE_MAX) {
    return errorResponse(`title must be at most ${WIDGET_TITLE_MAX} characters`, 400);
  }
  if (!isWidgetType(type)) {
    return errorResponse(`type must be one of ${WIDGET_TYPES.join(", ")}`, 400);
  }
  // Structural check only — deep spec validation happens in the query engine
  // at execution time, which is the single source of truth.
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return errorResponse("spec must be a JSON object", 400);
  }
  if (
    displayConfig !== undefined &&
    (displayConfig === null || typeof displayConfig !== "object" || Array.isArray(displayConfig))
  ) {
    return errorResponse("displayConfig must be a JSON object", 400);
  }

  // The widget row and its grid placement land together — a widget with no
  // placement renders through the grid's unpersisted client fallback, as a
  // narrow stack down the left edge, until someone drags a tile.
  const widget = await prisma.$transaction((tx) =>
    createWidgetWithPlacement(tx, { dashboardId, type }, () =>
      tx.widget.create({
        data: {
          dashboardId,
          title: title.trim(),
          type,
          spec: spec as object,
          displayConfig: (displayConfig as object) ?? {},
        },
      }),
    ),
  );
  return successResponse({ widget }, 201);
}
