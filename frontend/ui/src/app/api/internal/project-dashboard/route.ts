import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { resolveCreatorNames } from "@/lib/dashboard-read";

const projectDashboardSchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  dashboardId: z.string("dashboardId is required").min(1, "dashboardId is required"),
});

// POST /api/internal/project-dashboard
//
// Fetches one dashboard with its widgets (the public `get_dashboard` read),
// given a projectId the caller has ALREADY resolved from an authenticated
// credential. The lookup is scoped through the project id, so a dashboard in
// another project simply isn't found (404) — same scoping createWidget uses.
// Trust is the X-Internal-Secret plus the backend's verified project scope.
// Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = projectDashboardSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { projectId, dashboardId } = result.data;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: dashboardId, projectId },
    select: {
      id: true,
      name: true,
      description: true,
      isDefault: true,
      createdBy: true,
      createTime: true,
      updateTime: true,
      widgets: {
        orderBy: { createTime: "asc" as const },
        select: { id: true, title: true, type: true, spec: true, createTime: true },
      },
    },
  });
  if (!dashboard) {
    return NextResponse.json({ error: "Dashboard not found" }, { status: 404 });
  }

  const creators = await resolveCreatorNames([dashboard.createdBy]);
  const { createdBy, ...rest } = dashboard;
  return NextResponse.json({
    dashboard: { ...rest, creator: creators.get(createdBy) ?? null },
  });
}
