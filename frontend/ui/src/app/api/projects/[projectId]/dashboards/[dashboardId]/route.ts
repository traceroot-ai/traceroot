import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; dashboardId: string }> };

async function authorize(params: RouteParams["params"]) {
  const authResult = await requireAuth();
  if (authResult.error) return { error: authResult.error };
  const { projectId, dashboardId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return { error: accessResult.error };
  return { projectId, dashboardId };
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await authorize(params);
  if ("error" in auth) return auth.error;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: auth.dashboardId, projectId: auth.projectId },
    include: { widgets: { orderBy: { createTime: "asc" } } },
  });
  if (!dashboard) return errorResponse("Dashboard not found", 404);
  return successResponse({ dashboard });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await authorize(params);
  if ("error" in auth) return auth.error;

  // Parse and validate body before hitting the DB — fail fast on bad input.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Body must be a JSON object", 400);
  }
  const { name, description, layout } = body as Record<string, unknown>;

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
    where: { id: auth.dashboardId, projectId: auth.projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  const dashboard = await prisma.dashboard.update({
    where: { id: auth.dashboardId },
    data,
  });
  return successResponse({ dashboard });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await authorize(params);
  if ("error" in auth) return auth.error;

  const existing = await prisma.dashboard.findFirst({
    where: { id: auth.dashboardId, projectId: auth.projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  await prisma.dashboard.delete({ where: { id: auth.dashboardId } });
  return successResponse({ deleted: true });
}
