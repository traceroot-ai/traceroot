import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import {
  ALERT_CAP_MESSAGE,
  alertCreateData,
  validateAlertCreate,
} from "@/lib/write-services/alerts";
import { MAX_ALERTS_PER_PROJECT } from "./schema";
import { alertSelect, alertSummarySelect, serializeAlert, withCreators } from "./serialize";

type RouteParams = { params: Promise<{ projectId: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// `skip` is a 32-bit int in Prisma: an unclamped page reaches it out of range
// and 500s. At MAX_LIMIT this is still far more pages than a list can hold.
const MAX_PAGE = 10_000;

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId } = auth.params;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const page = isNaN(rawPage) ? 0 : Math.min(Math.max(rawPage, 0), MAX_PAGE);
  const searchQuery = searchParams.get("search_query")?.trim() || null;

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
  // cap. Advisory only — POST re-counts, so this stays out of the transaction.
  const used = searchQuery ? await prisma.alert.count({ where: { projectId } }) : total;

  return successResponse({
    data: await withCreators(rows),
    meta: { page, limit, total, capacity: { used, max: MAX_ALERTS_PER_PROJECT } },
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { user } = auth;
  const { projectId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  // One validator for the cookie UI and the public API: the write service
  // owns the zod shape and the cross-field checks, and hands back canonical
  // filters.
  const validated = validateAlertCreate(parsed.body);
  if (!validated.ok) return errorResponse(validated.error, 400);
  const { rule } = validated;

  // Advisory, not enforced: racing creates can both pass this count and leave a
  // project a slot or two over, which this cap tolerates.
  const existingCount = await prisma.alert.count({ where: { projectId } });
  if (existingCount >= MAX_ALERTS_PER_PROJECT) {
    return errorResponse(ALERT_CAP_MESSAGE, 409);
  }

  const alert = await prisma.alert.create({
    data: alertCreateData(rule, projectId, user.id),
    select: alertSelect,
  });

  return successResponse({ alert: await serializeAlert(alert) }, 201);
}
