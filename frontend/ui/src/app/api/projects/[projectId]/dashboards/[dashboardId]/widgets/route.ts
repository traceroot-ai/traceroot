import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { createWidgetWithPlacement } from "@/lib/dashboard-layout";
import {
  isWidgetType,
  WIDGET_TITLE_MAX,
  WIDGET_TYPES,
  WidgetSpecSchema,
} from "@/features/dashboards/types";
import { validateWidgetSpecVocabulary } from "@/features/dashboards/widget-spec-vocabulary";

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
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return errorResponse("spec must be a JSON object", 400);
  }
  if (
    displayConfig !== undefined &&
    (displayConfig === null || typeof displayConfig !== "object" || Array.isArray(displayConfig))
  ) {
    return errorResponse("displayConfig must be a JSON object", 400);
  }
  // A query spec that names fields the registry doesn't know stores fine and
  // then fails at query time forever, with no UI path to repair it — the same
  // vocabulary check the API/agent write path runs, so the guarantee holds on
  // both. Only specs that parse as query specs can be checked; anything the
  // schema can't read is still left to the query engine, as before.
  if (type === "query") {
    const parsedSpec = WidgetSpecSchema.safeParse(spec);
    if (parsedSpec.success) {
      const vocabulary = validateWidgetSpecVocabulary(parsedSpec.data);
      if (!vocabulary.ok) return errorResponse(vocabulary.error, 400);
    }
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
