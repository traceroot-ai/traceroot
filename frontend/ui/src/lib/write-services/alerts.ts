import type { Prisma } from "@prisma/client";
import { canonicalizeAlertFilters, prisma, type AlertFilter } from "@traceroot/core";
import {
  alertCreateSchema,
  firstIssueMessage,
  isAggregationValidForMeasure,
  isMeasureValidForView,
  MAX_ALERTS_PER_PROJECT,
  toAlertFilters,
  type AlertCreateInput,
} from "@/app/api/projects/[projectId]/alerts/schema";
import {
  alertSelect,
  serializeAlert,
  type AlertRecord,
  type AlertRow,
} from "@/app/api/projects/[projectId]/alerts/serialize";
import { writeAudit, type AuditEntry } from "./audit";
import { requireProjectMember } from "./project-access";
import type { Provenance, ServiceResult } from "./types";

/** A create body that passed every check, with its filters canonicalized. */
export type ValidatedAlertRule = Omit<AlertCreateInput, "filters"> & { filters: AlertFilter[] };

/**
 * The one validator for an alert create, shared by the cookie route and the
 * internal write route so the two surfaces cannot drift: the zod shape, then
 * the cross-field checks (measure per view, aggregation evaluable for the
 * measure and filters). Filters come back canonicalized — the scheduler's
 * dedup key is a fingerprint over the stored JSON, so they must be stored
 * in this form.
 */
export function validateAlertCreate(
  body: unknown,
): { ok: true; rule: ValidatedAlertRule } | { ok: false; error: string } {
  const result = alertCreateSchema.safeParse(body);
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) };
  const rule = result.data;

  if (!isMeasureValidForView(rule.view, rule.measure)) {
    return { ok: false, error: "Invalid measure for view" };
  }
  const filters = canonicalizeAlertFilters(toAlertFilters(rule.filters));
  if (!isAggregationValidForMeasure(rule.view, rule.measure, rule.aggregation, filters)) {
    return { ok: false, error: "Invalid aggregation for measure" };
  }
  return { ok: true, rule: { ...rule, filters } };
}

/** The cap message both surfaces return; the public proxy passes it through. */
export const ALERT_CAP_MESSAGE = `This project has reached its limit of ${MAX_ALERTS_PER_PROJECT} alerts`;

/**
 * The row a validated rule becomes, shared by the cookie route and this
 * service so the two inserts cannot drift.
 */
export function alertCreateData(
  rule: ValidatedAlertRule,
  projectId: string,
  createdBy: string,
): Prisma.AlertUncheckedCreateInput {
  return {
    projectId,
    name: rule.name,
    view: rule.view,
    measure: rule.measure,
    aggregation: rule.aggregation,
    filters: rule.filters as unknown as Prisma.InputJsonValue,
    window: rule.window,
    thresholdOperator: rule.thresholdOperator,
    threshold: rule.threshold,
    renotify: rule.renotify as Prisma.InputJsonValue,
    // Undefined leaves the column default, which is the reading a caller that
    // said nothing about gaps expects.
    noDataMode: rule.noDataMode,
    createdBy,
    // Due now, but no earlier: the scheduler orders on nextRunAt, so a new
    // rule takes its place in line rather than the front of it.
    nextRunAt: new Date(),
  };
}

/** What the create transaction returns: the raw row (serialized after commit,
 *  so the creator lookup never runs against an open transaction) plus the
 *  audit entry to record once the transaction has committed. */
type TxOutcome = Promise<
  | { result: { ok: false; status: 400 | 403 | 404 | 409; error: string } }
  | { row: AlertRow; audit: AuditEntry }
>;

/**
 * Create a threshold alert in a project for a trusted caller (the public API
 * proxy or the agent binding). Strict create: alerts have no unique name
 * index, so every call inserts and ``created`` is always true on success.
 */
export async function createAlert(input: {
  actorUserId: string;
  projectId: string;
  /** The raw rule fields, validated here. */
  rule: unknown;
  provenance: Provenance;
}): Promise<ServiceResult<AlertRecord>> {
  const validated = validateAlertCreate(input.rule);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const { rule } = validated;

  const outcome = await prisma.$transaction(async (tx): TxOutcome => {
    const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    // Advisory, not enforced: racing creates can both pass this count and
    // leave a project a slot or two over, which this cap tolerates.
    const existingCount = await tx.alert.count({ where: { projectId: input.projectId } });
    if (existingCount >= MAX_ALERTS_PER_PROJECT) {
      return { result: { ok: false, status: 409, error: ALERT_CAP_MESSAGE } };
    }

    const alert = await tx.alert.create({
      data: alertCreateData(rule, input.projectId, input.actorUserId),
      select: alertSelect,
    });
    return {
      row: alert,
      audit: {
        actorUserId: input.actorUserId,
        operation: "create_alert",
        resourceType: "alert",
        resourceId: alert.id,
        workspaceId: access.workspaceId,
        projectId: input.projectId,
        summary: {
          name: rule.name,
          view: rule.view,
          measure: rule.measure,
          aggregation: rule.aggregation,
          window: rule.window,
        },
        transport: input.provenance.transport,
        agentSessionId: input.provenance.agentSessionId ?? null,
      },
    };
  });

  if ("result" in outcome) return outcome.result;

  const data = await serializeAlert(outcome.row);
  await writeAudit(prisma, outcome.audit);
  return { ok: true, created: true, data };
}
