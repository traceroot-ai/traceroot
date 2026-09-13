import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { canonicalizeAlertFilters, prisma, Role } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import {
  alertCreateSchema,
  firstIssueMessage,
  isAggregationValidForMeasure,
  isMeasureValidForView,
  toAlertFilters,
} from "./schema";
import { alertSelect, alertSummarySelect, serializeAlert, withCreators } from "./serialize";

type RouteParams = { params: Promise<{ projectId: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// `skip` is a 32-bit int in Prisma: an unclamped page reaches it out of range
// and 500s. At MAX_LIMIT this is still far more pages than a list can hold.
const MAX_PAGE = 10_000;
// ALERT_CLAIM_SCAN_LIMIT / 10, so ten projects stay visible to the scheduler's
// round-robin. Bounds one tenant's share, not total load.
const MAX_ALERTS_PER_PROJECT = 100;

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
      orderBy: { createTime: "asc" },
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

  const result = alertCreateSchema.safeParse(parsed.body);
  if (!result.success) return errorResponse(firstIssueMessage(result.error), 400);
  const rule = result.data;

  if (!isMeasureValidForView(rule.view, rule.measure)) {
    return errorResponse("Invalid measure for view", 400);
  }
  const filters = canonicalizeAlertFilters(toAlertFilters(rule.filters));
  if (!isAggregationValidForMeasure(rule.view, rule.measure, rule.aggregation, filters)) {
    return errorResponse("Invalid aggregation for measure", 400);
  }

  // Advisory, not enforced: racing creates can both pass this count and leave a
  // project a slot or two over, which this cap tolerates.
  const existingCount = await prisma.alert.count({ where: { projectId } });
  if (existingCount >= MAX_ALERTS_PER_PROJECT) {
    return errorResponse(
      `This project has reached its limit of ${MAX_ALERTS_PER_PROJECT} alerts`,
      409,
    );
  }

  const alert = await prisma.alert.create({
    data: {
      projectId,
      name: rule.name,
      view: rule.view,
      measure: rule.measure,
      aggregation: rule.aggregation,
      filters: filters as unknown as Prisma.InputJsonValue,
      window: rule.window,
      thresholdOperator: rule.thresholdOperator,
      threshold: rule.threshold,
      renotify: rule.renotify as Prisma.InputJsonValue,
      // Undefined leaves the column default, which is the reading a caller that
      // said nothing about gaps expects.
      noDataMode: rule.noDataMode,
      createdBy: user.id,
      // Due now, but no earlier: the scheduler orders on nextRunAt, so a new
      // rule takes its place in line rather than the front of it.
      nextRunAt: new Date(),
    },
    select: alertSelect,
  });

  return successResponse({ alert: await serializeAlert(alert) }, 201);
}
