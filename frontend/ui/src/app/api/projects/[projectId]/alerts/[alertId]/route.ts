import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { canonicalizeAlertFilters, prisma, Role, type AlertFilter } from "@traceroot/core";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { parseJsonObject, requireProjectAuth } from "@/lib/route-helpers";
import {
  alertUpdateSchema,
  firstIssueMessage,
  isAggregationValidForMeasure,
  isMeasureValidForView,
  toAlertFilters,
} from "../schema";
import { alertSelect, serializeAlert } from "../serialize";
import {
  alertStateReset,
  hasRuleChanged,
  toRuleSnapshot,
  type AlertRuleSnapshot,
} from "../rule-state";

type RouteParams = { params: Promise<{ projectId: string; alertId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: alertSelect,
  });
  if (!alert) return errorResponse("Alert not found", 404);

  return successResponse({ alert: await serializeAlert(alert) });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = alertUpdateSchema.safeParse(parsed.body);
  if (!result.success) return errorResponse(firstIssueMessage(result.error), 400);
  const update = result.data;

  const canonicalFilters: AlertFilter[] | undefined =
    update.filters === undefined
      ? undefined
      : canonicalizeAlertFilters(toAlertFilters(update.filters));

  const data: Prisma.AlertUpdateManyMutationInput = {};
  if (update.name !== undefined) data.name = update.name;
  if (update.view !== undefined) data.view = update.view;
  if (update.measure !== undefined) data.measure = update.measure;
  if (update.aggregation !== undefined) data.aggregation = update.aggregation;
  if (canonicalFilters !== undefined) {
    data.filters = canonicalFilters as unknown as Prisma.InputJsonValue;
  }
  if (update.window !== undefined) data.window = update.window;
  if (update.thresholdOperator !== undefined) data.thresholdOperator = update.thresholdOperator;
  if (update.threshold !== undefined) data.threshold = update.threshold;
  if (update.renotify !== undefined) data.renotify = update.renotify as Prisma.InputJsonValue;
  if (update.noDataMode !== undefined) data.noDataMode = update.noDataMode;
  if (Object.keys(data).length === 0) return errorResponse("No fields to update", 400);

  const existing = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: alertSelect,
  });
  if (!existing) return errorResponse("Alert not found", 404);

  // Merged with the stored rule: an aggregation-only edit still has to hold
  // against the stored measure, and a filters-only edit against both.
  const view = update.view ?? existing.view;
  const measure = update.measure ?? existing.measure;
  const aggregation = update.aggregation ?? existing.aggregation;
  const filters = canonicalFilters ?? (existing.filters as unknown as AlertFilter[]);
  const rewritesQuery =
    update.view !== undefined ||
    update.measure !== undefined ||
    update.aggregation !== undefined ||
    update.filters !== undefined;
  if (rewritesQuery) {
    if (!isMeasureValidForView(view, measure)) {
      return errorResponse("Invalid measure for view", 400);
    }
    if (!isAggregationValidForMeasure(view, measure, aggregation, filters)) {
      return errorResponse("Invalid aggregation for measure", 400);
    }
  }

  const nextRule: Partial<AlertRuleSnapshot> = {
    view: update.view,
    measure: update.measure,
    aggregation: update.aggregation,
    filters: canonicalFilters,
    window: update.window,
    thresholdOperator: update.thresholdOperator,
    threshold: update.threshold,
  };
  if (hasRuleChanged(toRuleSnapshot(existing), nextRule)) {
    Object.assign(data, alertStateReset());
  }

  // Scoped write rather than a write on `id` alone: the project scope is the
  // tenancy check, so it belongs on the statement that mutates.
  const { count } = await prisma.alert.updateMany({ where: { id: alertId, projectId }, data });
  if (count === 0) return errorResponse("Alert not found", 404);

  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: alertSelect,
  });
  if (!alert) return errorResponse("Alert not found", 404);

  return successResponse({ alert: await serializeAlert(alert) });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireProjectAuth(params, Role.MEMBER);
  if (auth.error) return auth.error;
  const { projectId, alertId } = auth.params;

  const { count } = await prisma.alert.deleteMany({ where: { id: alertId, projectId } });
  if (count === 0) return errorResponse("Alert not found", 404);

  return successResponse({ success: true });
}
