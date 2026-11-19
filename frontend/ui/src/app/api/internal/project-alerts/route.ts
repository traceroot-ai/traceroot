import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { MAX_ALERTS_PER_PROJECT } from "@/app/api/projects/[projectId]/alerts/schema";
import {
  alertSelect,
  alertSummarySelect,
  serializeAlert,
  withCreators,
} from "@/app/api/projects/[projectId]/alerts/serialize";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// `skip` is a 32-bit int in Prisma: an unclamped page reaches it out of range
// and 500s. At MAX_LIMIT this is still far more pages than a list can hold.
const MAX_PAGE = 10_000;

const projectAlertsSchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  // Present: fetch that one alert. Absent: list the project's alerts.
  alertId: z.string("alertId must be a string").min(1, "alertId must be a string").optional(),
  limit: z.number().int().optional(),
  page: z.number().int().optional(),
  searchQuery: z.string().optional(),
});

// POST /api/internal/project-alerts
//
// Lists a project's alerts (the public `list_alerts` read) or fetches one of
// them (`get_alert`), given a projectId the caller has ALREADY resolved from
// an authenticated credential. Used by the Python backend for both the public
// dual-credential routes and their internal project-scoped mirror; trust is
// the X-Internal-Secret plus the backend's verified project scope. The lookup
// is scoped through the project id, so an alert in another project simply
// isn't found (404). Never log ids.
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

  const result = projectAlertsSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { projectId, alertId } = result.data;

  if (alertId !== undefined) {
    const alert = await prisma.alert.findFirst({
      where: { id: alertId, projectId },
      select: alertSelect,
    });
    if (!alert) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }
    return NextResponse.json({ alert: await serializeAlert(alert) });
  }

  // Clamped rather than rejected, like the cookie route: the public layer
  // validates the ranges it documents, and this route stays tolerant of it.
  const limit = Math.min(Math.max(result.data.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const page = Math.min(Math.max(result.data.page ?? 0, 0), MAX_PAGE);
  const searchQuery = result.data.searchQuery?.trim() || null;

  const where = searchQuery
    ? { projectId, name: { contains: searchQuery, mode: "insensitive" as const } }
    : { projectId };

  const [rows, total] = await prisma.$transaction([
    prisma.alert.findMany({
      where,
      select: alertSummarySelect,
      // The id breaks createTime ties so offset paging never skips or repeats a
      // row across pages.
      orderBy: [{ createTime: "asc" }, { id: "asc" }],
      skip: page * limit,
      take: limit,
    }),
    prisma.alert.count({ where }),
  ]);

  // `total` counts the search, not the project, so it cannot stand in for the
  // cap. Advisory only, the same reading the cookie route gives.
  const used = searchQuery ? await prisma.alert.count({ where: { projectId } }) : total;

  return NextResponse.json({
    alerts: rows.length === 0 ? [] : await withCreators(rows),
    meta: { page, limit, total, capacity: { used, max: MAX_ALERTS_PER_PROJECT } },
  });
}
