import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { isRecordGone, parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { DASHBOARD_DESCRIPTION_MAX, DASHBOARD_NAME_MAX } from "@/features/dashboards/types";

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
  const auth = await requireProjectAuth(params, Role.MEMBER);
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
    if (name.trim().length > DASHBOARD_NAME_MAX) {
      return errorResponse(`name must be at most ${DASHBOARD_NAME_MAX} characters`, 400);
    }
    data.name = name.trim();
  }
  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      return errorResponse("description must be a string or null", 400);
    }
    if (typeof description === "string" && description.length > DASHBOARD_DESCRIPTION_MAX) {
      return errorResponse(
        `description must be at most ${DASHBOARD_DESCRIPTION_MAX} characters`,
        400,
      );
    }
    data.description = description;
  }
  if (layout !== undefined) {
    if (!Array.isArray(layout)) return errorResponse("layout must be an array", 400);
    // Validate every entry: a single malformed one (null, missing keys,
    // non-numeric coordinates) crashes the dashboard grid for every project
    // member on the next read, with no UI path to repair it.
    const isPlacement = (v: unknown): boolean =>
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).i === "string" &&
      ((v as Record<string, unknown>).i as string).length <= 128 &&
      ["x", "y", "w", "h"].every((k) => {
        const n = (v as Record<string, unknown>)[k];
        return typeof n === "number" && Number.isFinite(n) && n >= 0;
      });
    if (!layout.every(isPlacement)) {
      return errorResponse("layout entries must be {i, x, y, w, h} objects", 400);
    }
    // Store only the placement keys: the grid spreads stored entries into
    // react-grid-layout items, so extra keys smuggled through PATCH (static,
    // isDraggable, maxW, arbitrary payloads) would be persisted and honored
    // for every member.
    data.layout = (layout as Record<string, unknown>[]).map(({ i, x, y, w, h }) => ({
      i,
      x,
      y,
      w,
      h,
    }));
  }
  if (Object.keys(data).length === 0) return errorResponse("No fields to update", 400);

  const existing = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  try {
    const dashboard = await prisma.dashboard.update({
      where: { id: dashboardId },
      data,
    });
    return successResponse({ dashboard });
  } catch (e) {
    // Deleted concurrently between the scoped findFirst and this write.
    if (isRecordGone(e)) return errorResponse("Dashboard not found", 404);
    throw e;
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, dashboardId } = auth.params;

  const existing = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
  });
  if (!existing) return errorResponse("Dashboard not found", 404);

  // The list endpoint reseeds the default dashboard whenever a project has
  // zero dashboards, so deleting the last one would just resurrect a fresh
  // seeded copy — block it instead (the list UI disables this path too).
  const remaining = await prisma.dashboard.count({ where: { projectId } });
  if (remaining <= 1) {
    return errorResponse("Cannot delete a project's last dashboard", 409);
  }

  try {
    await prisma.dashboard.delete({ where: { id: dashboardId } });
  } catch (e) {
    // Deleted concurrently between the scoped findFirst and this write.
    if (isRecordGone(e)) return errorResponse("Dashboard not found", 404);
    throw e;
  }
  return successResponse({ deleted: true });
}
