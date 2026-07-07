import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = {
  params: Promise<{ projectId: string; dashboardId: string; widgetId: string }>;
};

async function findWidget(dashboardId: string, widgetId: string, projectId: string) {
  return prisma.widget.findFirst({
    where: { id: widgetId, dashboardId, dashboard: { projectId } },
  });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, dashboardId, widgetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const existing = await findWidget(dashboardId, widgetId, projectId);
  if (!existing) return errorResponse("Widget not found", 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Body must be a JSON object", 400);
  }
  const { title, spec, displayConfig } = body as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return errorResponse("title must be a non-empty string", 400);
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

  const widget = await prisma.widget.update({
    where: { id: widgetId },
    data,
  });
  return successResponse({ widget });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, dashboardId, widgetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const existing = await findWidget(dashboardId, widgetId, projectId);
  if (!existing) return errorResponse("Widget not found", 404);

  await prisma.widget.delete({ where: { id: widgetId } });
  return successResponse({ deleted: true });
}
