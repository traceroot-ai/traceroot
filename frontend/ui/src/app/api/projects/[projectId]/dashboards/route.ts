import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import { defaultDashboardId, seedWidgets } from "@/lib/dashboard-seed";
import { DASHBOARD_DESCRIPTION_MAX, DASHBOARD_NAME_MAX } from "@/features/dashboards/types";

type RouteParams = { params: Promise<{ projectId: string }> };

const listArgs = (projectId: string) => ({
  where: { projectId },
  orderBy: [{ isDefault: "desc" as const }, { createTime: "asc" as const }],
  select: { id: true, name: true, description: true, isDefault: true, updateTime: true },
});

// GET /api/projects/[projectId]/dashboards — list; lazily seeds the default
// "Overview" dashboard the first time a project's dashboards are fetched.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { user } = auth;
  const { projectId } = auth.params;

  let dashboards = await prisma.dashboard.findMany(listArgs(projectId));

  if (dashboards.length === 0) {
    const widgets = seedWidgets();
    const seeded = widgets.map((w, i) => ({ ...w, id: `seed-${i}-${projectId}` }));
    try {
      await prisma.dashboard.create({
        data: {
          id: defaultDashboardId(projectId),
          projectId,
          name: "Overview",
          isDefault: true,
          createdBy: user.id,
          // layout keys MUST equal widget ids (react-grid-layout matches on `i`)
          layout: seeded.map((w) => ({ i: w.id, ...w.layout })),
          widgets: {
            create: seeded.map((w) => ({ id: w.id, title: w.title, type: w.type, spec: w.spec })),
          },
        },
      });
    } catch (e) {
      // Concurrent first-visit: another request already created it (PK clash).
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    }
    dashboards = await prisma.dashboard.findMany(listArgs(projectId));
  }

  return successResponse({ data: dashboards });
}

// POST /api/projects/[projectId]/dashboards — create a named dashboard
export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { user } = auth;
  const { projectId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;
  const { name, description } = parsed.body;
  if (typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("name must be a non-empty string", 400);
  }
  if (name.trim().length > DASHBOARD_NAME_MAX) {
    return errorResponse(`name must be at most ${DASHBOARD_NAME_MAX} characters`, 400);
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return errorResponse("description must be a string", 400);
  }
  if (typeof description === "string" && description.length > DASHBOARD_DESCRIPTION_MAX) {
    return errorResponse(
      `description must be at most ${DASHBOARD_DESCRIPTION_MAX} characters`,
      400,
    );
  }

  const dashboard = await prisma.dashboard.create({
    data: {
      projectId,
      name: name.trim(),
      description: (description as string) ?? null,
      createdBy: user.id,
    },
  });
  return successResponse({ dashboard }, 201);
}
