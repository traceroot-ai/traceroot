import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { resolveCreatorNames } from "@/lib/dashboard-read";

const projectDashboardsSchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
});

// POST /api/internal/project-dashboards
//
// Lists a project's dashboard catalog (the public `list_dashboards` read),
// given a projectId the caller has ALREADY resolved from an authenticated
// credential. Used by the Python backend for both the public dual-credential
// route and its internal project-scoped mirror; trust is the
// X-Internal-Secret plus the backend's verified project scope. A pure read:
// unlike the cookie route, it never seeds the default dashboard. Never log ids.
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

  const result = projectDashboardsSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { projectId } = result.data;

  const dashboards = await prisma.dashboard.findMany({
    where: { projectId },
    orderBy: [{ isDefault: "desc" as const }, { createTime: "asc" as const }],
    select: {
      id: true,
      name: true,
      description: true,
      isDefault: true,
      createdBy: true,
      createTime: true,
      updateTime: true,
      _count: { select: { widgets: true } },
    },
  });

  if (dashboards.length === 0) {
    return NextResponse.json({ dashboards: [] });
  }

  const creators = await resolveCreatorNames(dashboards.map((d) => d.createdBy));
  return NextResponse.json({
    dashboards: dashboards.map(({ createdBy, _count, ...d }) => ({
      ...d,
      creator: creators.get(createdBy) ?? null,
      widgetCount: _count.widgets,
    })),
  });
}
