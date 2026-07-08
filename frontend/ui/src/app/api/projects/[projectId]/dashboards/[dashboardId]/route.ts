import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";

type RouteParams = { params: Promise<{ projectId: string; dashboardId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
    include: { widgets: { orderBy: { createTime: "asc" } } },
  });
  if (!dashboard) return errorResponse("Dashboard not found", 404);
  return successResponse({ dashboard });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  // Parse and validate body before hitting the DB — fail fast on bad input.
  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;
  const { name, description, layout } = parsed.body;

  const data: Record<string, unknown> = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return errorResponse("name must be a non-empty string", 400);
    }
    data.name = name.trim();
  }
  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      return errorResponse("description must be a string or null", 400);
    }
    data.description = description;
  }
  if (layout !== undefined) {
    if (!Array.isArray(layout)) return errorResponse("layout must be an array", 400);
    data.layout = layout;
  }
  if (Object.keys(data).length === 0) return errorResponse("No fields to update", 400);

  const existing = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  const dashboard = await prisma.dashboard.update({
    where: { id: dashboardId },
    data,
  });
  return successResponse({ dashboard });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const existing = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  await prisma.dashboard.delete({ where: { id: dashboardId } });
  return successResponse({ deleted: true });
}
