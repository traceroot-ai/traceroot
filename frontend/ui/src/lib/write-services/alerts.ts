/**
 * Alert writes for every surface: the public API proxy, the agent binding and
 * the web app's cookie routes all land here.
 *
 * `updateAlert` is PATCH semantics: a rule field the caller leaves out is
 * untouched. It reads the row, validates the patch merged with the stored
 * rule, diffs it and writes only when something differs, carrying the three
 * behaviors that make an edited rule safe to evaluate: the cold start on a
 * rule change, the parked re-arm, and canonical filters. A future
 * `replaceAlert` (PUT) would validate a full body with the create schema and
 * call the same diff-and-write core; the core is shared on purpose.
 */
import type { Prisma } from "@prisma/client";
import {
  canonicalizeAlertFilters,
  hasOutstandingAlertPage,
  prisma,
  STOPPED_ALERT_STATUSES,
  type AlertFilter,
} from "@traceroot/core";
import {
  alertCreateSchema,
  alertPauseSchema,
  alertUpdateSchema,
  firstIssueMessage,
  isAggregationValidForMeasure,
  isMeasureValidForView,
  MAX_ALERTS_PER_PROJECT,
  toAlertFilters,
  type AlertCreateInput,
  type AlertUpdateInput,
} from "@/app/api/projects/[projectId]/alerts/schema";
import {
  alertStateReset,
  hasRuleChanged,
  toRuleSnapshot,
  type AlertRuleSnapshot,
} from "@/app/api/projects/[projectId]/alerts/rule-state";
import {
  alertSelect,
  toAlertRecord,
  type AlertRecord,
  type AlertRow,
} from "@/app/api/projects/[projectId]/alerts/serialize";
import { writeAudit, type AuditEntry } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

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

/** What the create transaction returns: the finished record (every lookup it
 *  needs runs on the transaction client, so nothing fallible sits between the
 *  commit and the success answer) plus the audit entry to record once the
 *  transaction has committed. */
type TxOutcome = Promise<
  | { result: { ok: false; status: 400 | 403 | 404 | 409; error: string } }
  | { data: AlertRecord; audit: AuditEntry }
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

    // The creator is the actor, resolved here on the transaction client: a
    // lookup after the commit could fail and turn a stored alert into an
    // error answer, and a retry of this strict create would then duplicate
    // it. A creator with an empty name falls through to the email, like the
    // read serializer.
    const actor = await tx.user.findUnique({
      where: { id: input.actorUserId },
      select: { name: true, email: true },
    });
    const creator = actor ? actor.name || actor.email : null;

    const alert = await tx.alert.create({
      data: alertCreateData(rule, input.projectId, input.actorUserId),
      select: alertSelect,
    });
    return {
      data: toAlertRecord(alert, creator),
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

  // Best-effort by design and the only thing after the commit: the answer
  // below needs no further I/O, so the alert can never exist unreported.
  await writeAudit(prisma, outcome.audit);
  return { ok: true, created: true, data: outcome.data };
}

/** An update body that passed the shape check, with its filters canonicalized. */
export type ValidatedAlertPatch = Omit<AlertUpdateInput, "filters"> & { filters?: AlertFilter[] };

/**
 * The shape check for an alert patch: the partial rule schema, then the
 * filters canonicalized as on create. The cross-field checks wait for the
 * stored rule, since an aggregation-only edit is only checkable against the
 * measure it will run with.
 */
export function validateAlertPatch(
  body: unknown,
): { ok: true; patch: ValidatedAlertPatch } | { ok: false; error: string } {
  const result = alertUpdateSchema.safeParse(body);
  if (!result.success) return { ok: false, error: firstIssueMessage(result.error) };
  const { filters } = result.data;
  // Spread over the parsed shape so `filters` keeps its place in the field
  // order, which is the order `changed` reports.
  const patch: ValidatedAlertPatch = {
    ...result.data,
    ...(filters === undefined
      ? {}
      : { filters: canonicalizeAlertFilters(toAlertFilters(filters)) }),
  };
  if (definedKeys(patch).length === 0) return { ok: false, error: NO_FIELDS_MESSAGE };
  return { ok: true, patch };
}

/**
 * The columns a validated patch writes, beside `alertCreateData`: only the
 * fields the patch carries, so an absent field stays untouched.
 */
export function alertUpdateData(patch: ValidatedAlertPatch): Prisma.AlertUpdateManyMutationInput {
  const data: Prisma.AlertUpdateManyMutationInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.view !== undefined) data.view = patch.view;
  if (patch.measure !== undefined) data.measure = patch.measure;
  if (patch.aggregation !== undefined) data.aggregation = patch.aggregation;
  if (patch.filters !== undefined) data.filters = patch.filters as unknown as Prisma.InputJsonValue;
  if (patch.window !== undefined) data.window = patch.window;
  if (patch.thresholdOperator !== undefined) data.thresholdOperator = patch.thresholdOperator;
  if (patch.threshold !== undefined) data.threshold = patch.threshold;
  if (patch.renotify !== undefined) data.renotify = patch.renotify as Prisma.InputJsonValue;
  if (patch.noDataMode !== undefined) data.noDataMode = patch.noDataMode;
  return data;
}

type Tx = Prisma.TransactionClient;

const ALERT_NOT_FOUND = { ok: false, status: 404, error: "Alert not found" } as const;
const PARKED_MESSAGE = "This alert was parked by the evaluator; resume it to run it again.";

/**
 * The record for the answer, with the creator resolved on the transaction
 * client so nothing fallible sits between the commit and the success answer.
 */
async function recordOf(tx: Tx, alert: AlertRow): Promise<AlertRecord> {
  const creator = await tx.user.findUnique({
    where: { id: alert.createdBy },
    select: { name: true, email: true },
  });
  return toAlertRecord(alert, creator ? creator.name || creator.email : null);
}

function auditEntry(
  input: { actorUserId: string; projectId: string; provenance: Provenance },
  workspaceId: string,
  operation: string,
  resourceId: string,
  summary: Record<string, unknown>,
): AuditEntry {
  return {
    actorUserId: input.actorUserId,
    operation,
    resourceType: "alert",
    resourceId,
    workspaceId,
    projectId: input.projectId,
    summary,
    transport: input.provenance.transport,
    agentSessionId: input.provenance.agentSessionId ?? null,
  };
}

/**
 * Partially update an alert rule for a MEMBER of its project. The patch is
 * validated merged with the stored rule; any change to an evaluated field
 * voids the evaluation state (a cold start, due now) and the answer says so,
 * with `pageCleared` when the state it voided held an open page. An edit that
 * rewrites the rule or its renotify settings re-arms a parked alert through
 * a status compare-and-set; a name-only edit leaves it parked.
 */
export async function updateAlert(input: {
  actorUserId: string;
  projectId: string;
  alertId: string;
  /** The raw rule fields, validated here. */
  patch: unknown;
  provenance: Provenance;
}): Promise<UpdateResult<AlertRecord>> {
  const { projectId, alertId } = input;
  const outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<AlertRecord>> => {
    const access = await requireProjectMember(tx, projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    const validated = validateAlertPatch(input.patch);
    if (!validated.ok) return { result: { ok: false, status: 400, error: validated.error } };
    const { patch } = validated;

    const existing = await tx.alert.findFirst({
      where: { id: alertId, projectId },
      select: alertSelect,
    });
    if (!existing) return { result: ALERT_NOT_FOUND };

    // Merged with the stored rule: an aggregation-only edit still has to hold
    // against the stored measure, and a filters-only edit against both.
    const view = patch.view ?? existing.view;
    const measure = patch.measure ?? existing.measure;
    const aggregation = patch.aggregation ?? existing.aggregation;
    const filters = patch.filters ?? (existing.filters as unknown as AlertFilter[]);
    const rewritesQuery =
      patch.view !== undefined ||
      patch.measure !== undefined ||
      patch.aggregation !== undefined ||
      patch.filters !== undefined;
    if (rewritesQuery) {
      if (!isMeasureValidForView(view, measure)) {
        return { result: { ok: false, status: 400, error: "Invalid measure for view" } };
      }
      if (!isAggregationValidForMeasure(view, measure, aggregation, filters)) {
        return { result: { ok: false, status: 400, error: "Invalid aggregation for measure" } };
      }
    }

    const snapshot = toRuleSnapshot(existing);
    const { changed, data: edit } = diffPatch(patch, {
      ...snapshot,
      name: existing.name,
      renotify: existing.renotify,
    });
    if (changed.length === 0) {
      return {
        result: {
          ok: true,
          data: await recordOf(tx, existing),
          changed,
          stateReset: false,
          pageCleared: false,
        },
      };
    }

    const nextRule: Partial<AlertRuleSnapshot> = {
      view: edit.view,
      measure: edit.measure,
      aggregation: edit.aggregation,
      filters: edit.filters,
      window: edit.window,
      thresholdOperator: edit.thresholdOperator,
      threshold: edit.threshold,
      noDataMode: edit.noDataMode,
    };
    const rewritesRule = hasRuleChanged(snapshot, nextRule);
    const data: Prisma.AlertUpdateManyMutationInput = {
      ...alertUpdateData(edit),
      ...(rewritesRule ? alertStateReset() : {}),
    };

    // The edit is how a parked rule re-arms: parking is a verdict about the
    // stored settings, and this is the write that replaces them. `renotify`
    // counts even though it is not part of the evaluated rule — a renotify the
    // worker cannot parse parks the rule too, and this write is a well-formed
    // one. A name-only edit changes nothing the evaluator refused, so it leaves
    // the rule parked rather than re-arming it for one more identical failure.
    //
    // Guarded by a status CAS in the write itself, not by `existing.status`: a
    // concurrent tick can park the rule after `existing` was read here, and the
    // commit has to catch that at write time or a rule this very edit fixes is
    // left parked on a stale read.
    const reArmsParked = rewritesRule || edit.renotify !== undefined;
    const reArmFields = { status: "ACTIVE" as const, ...alertStateReset() };
    const tryReArm = () =>
      tx.alert.updateMany({
        where: { id: alertId, projectId, status: "PARKED" },
        data: { ...data, ...reArmFields },
      });

    let count = reArmsParked ? (await tryReArm()).count : 0;
    let reArmed = count === 1;

    // Scoped write rather than a write on `id` alone: the project scope is the
    // tenancy check, so it belongs on the statement that mutates. Falls back to
    // it whenever the re-arm CAS above did not apply: the row was not actually
    // PARKED at that check, so this edit's ordinary fields still have to land.
    if (count !== 1) {
      // An edit that would re-arm a parked rule also has to void the claim a tick
      // may still hold on the row, in this same write. A rule rewrite already does
      // through `alertStateReset`; a renotify-only edit does not reset state, so
      // without this a park still in flight from that claim matches the old
      // `lastClaimedAt` after this returns and parks the rule this edit repaired.
      // `nextRunAt` moves with it, because the voided claim's evaluation will not
      // write back and the next tick should redo it rather than wait the cadence.
      const fallback = reArmsParked
        ? { ...data, lastClaimedAt: null, nextRunAt: new Date() }
        : data;
      ({ count } = await tx.alert.updateMany({
        where: { id: alertId, projectId },
        data: fallback,
      }));
      // A tick can still park the rule in the gap between the check above and
      // this write landing (the fallback has no status guard, so it would
      // otherwise commit the fix and leave the row parked). One retry closes
      // that: it costs nothing when nothing raced, and a further adversarial
      // interleaving past this is a rule that stays parked until an explicit
      // Resume, not a wrong or corrupted write.
      if (reArmsParked && count > 0) {
        reArmed = (await tryReArm()).count === 1;
      }
    }
    if (count === 0) return { result: ALERT_NOT_FOUND };

    const alert = await tx.alert.findFirst({
      where: { id: alertId, projectId },
      select: alertSelect,
    });
    if (!alert) return { result: ALERT_NOT_FOUND };

    const stateReset = rewritesRule || reArmed;
    return {
      result: {
        ok: true,
        data: await recordOf(tx, alert),
        changed,
        stateReset,
        pageCleared: stateReset && hasOutstandingAlertPage(existing),
      },
      audit: auditEntry(input, access.workspaceId, "update_alert", alertId, { changed }),
    };
  });

  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Pause or resume an alert for a MEMBER of its project. Only ACTIVE and
 * PAUSED are settable: PARKED is the evaluator's verdict and cannot be
 * requested. Pausing keeps the severity it stopped at; resuming is a cold
 * start, because the gap it was paused for was never evaluated. Kept apart
 * from `updateAlert` so a pause never round-trips the rule payload it could
 * clobber.
 */
export async function setAlertStatus(input: {
  actorUserId: string;
  projectId: string;
  alertId: string;
  /** "ACTIVE" or "PAUSED", validated here. */
  status: unknown;
  provenance: Provenance;
}): Promise<UpdateResult<AlertRecord>> {
  const { projectId, alertId } = input;
  const outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<AlertRecord>> => {
    const access = await requireProjectMember(tx, projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    const parsed = alertPauseSchema.safeParse({ status: input.status });
    if (!parsed.success) {
      return { result: { ok: false, status: 400, error: firstIssueMessage(parsed.error) } };
    }
    const { status } = parsed.data;

    const existing = await tx.alert.findFirst({
      where: { id: alertId, projectId },
      select: alertSelect,
    });
    if (!existing) return { result: ALERT_NOT_FOUND };
    if (existing.status === status) {
      return {
        result: {
          ok: true,
          data: await recordOf(tx, existing),
          changed: [],
          stateReset: false,
          pageCleared: false,
        },
      };
    }
    // Pausing a parked rule would relabel the evaluator's verdict as a stop
    // the owner chose and hide the reason the rule gives for not running.
    if (status === "PAUSED" && existing.status === "PARKED") {
      return { result: { ok: false, status: 409, error: PARKED_MESSAGE } };
    }

    // The transition is the WHERE, not the read above, which a tick could
    // race: a resume matches the stopped statuses (PARKED resumes the same
    // way, as the operator's retry of the rule), a pause matches a running
    // rule only.
    const { count } =
      status === "ACTIVE"
        ? await tx.alert.updateMany({
            where: { id: alertId, projectId, status: { in: [...STOPPED_ALERT_STATUSES] } },
            data: { status, ...alertStateReset() },
          })
        : await tx.alert.updateMany({
            where: { id: alertId, projectId, status: "ACTIVE" },
            data: { status },
          });
    const alert = await tx.alert.findFirst({
      where: { id: alertId, projectId },
      select: alertSelect,
    });
    if (!alert) return { result: ALERT_NOT_FOUND };
    if (count === 0) {
      // The row moved between the read and the write: another caller already
      // set this status (a no-op, as if this call had read it), or a tick
      // parked the rule (the pause is refused as above).
      if (alert.status === status) {
        return {
          result: {
            ok: true,
            data: await recordOf(tx, alert),
            changed: [],
            stateReset: false,
            pageCleared: false,
          },
        };
      }
      return { result: { ok: false, status: 409, error: PARKED_MESSAGE } };
    }
    const stateReset = status === "ACTIVE";
    return {
      result: {
        ok: true,
        data: await recordOf(tx, alert),
        changed: ["status"],
        stateReset,
        pageCleared: stateReset && hasOutstandingAlertPage(existing),
      },
      audit: auditEntry(input, access.workspaceId, "set_alert_status", alertId, {
        changed: ["status"],
        status,
      }),
    };
  });

  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Hard-delete an alert for a MEMBER of its project. An outstanding page is
 * not notified as resolved; the answer carries `pageCleared` when one was
 * open so the caller can say so.
 */
export async function deleteAlert(input: {
  actorUserId: string;
  projectId: string;
  alertId: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  const { projectId, alertId } = input;
  const outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
    const access = await requireProjectMember(tx, projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    const existing = await tx.alert.findFirst({
      where: { id: alertId, projectId },
      select: { id: true, name: true, severity: true, alertedAt: true },
    });
    if (!existing) return { result: ALERT_NOT_FOUND };

    const { count } = await tx.alert.deleteMany({ where: { id: alertId, projectId } });
    if (count === 0) return { result: ALERT_NOT_FOUND };

    const pageCleared = hasOutstandingAlertPage(existing);
    return {
      result: {
        ok: true,
        data: { id: existing.id, name: existing.name },
        reason: reason.reason,
        pageCleared,
      },
      audit: auditEntry(input, access.workspaceId, "delete_alert", alertId, {
        name: existing.name,
        reason: reason.reason,
        pageCleared,
      }),
    };
  });

  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
