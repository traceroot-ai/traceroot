import { prisma, type AlertSeverity, type AlertStatus } from "@traceroot/core";
import { mapWithConcurrency } from "./concurrency.js";
import { logError, logInfo } from "./log.js";
import { parseAlertRule, type AlertRowLike, type AlertRule } from "./rule.js";
import type { AlertRuntimeState } from "./state-machine.js";
import type { AlertTick } from "./tick.js";

const ACTIVE: AlertStatus = "ACTIVE";
const PARKED: AlertStatus = "PARKED";

/**
 * Leftovers lead the next tick only while the due set fits `ALERT_CLAIM_SCAN_LIMIT`:
 * a project whose due rules all sort past the scan cap is not seen by the tick at all.
 */
export const ALERT_CLAIM_LIMIT = 500;

/** Headroom over the budget: read exactly the budget and one project's backlog fills it. */
export const ALERT_CLAIM_SCAN_LIMIT = ALERT_CLAIM_LIMIT * 2;

/**
 * The CAS is per row and cannot be batched, so the whole limit at once queues behind
 * the Prisma pool shared with the detector consumers and surfaces as a `P2024` that
 * loses the tick's batch. Ten matches the detector run processor's queue concurrency.
 */
export const ALERT_CLAIM_CONCURRENCY = 10;

export interface ClaimedAlert {
  readonly rule: AlertRule;
  /** The `lastClaimedAt` this tick wrote; the write-back CAS matches on it. */
  readonly claimStamp: Date;
}

interface DueAlertRow extends AlertRowLike {
  readonly lastClaimedAt: Date | null;
}

/** Says what the owner can do about it: nothing else on the row will. */
const UNEVALUABLE_RULE_ERROR =
  "this rule's saved settings cannot be evaluated by the running build, so it will not fire; " +
  "open it and save it again to correct them";

async function claimRow(row: DueAlertRow, tick: AlertTick): Promise<ClaimedAlert | null> {
  let count: number;
  try {
    ({ count } = await prisma.alert.updateMany({
      where: { id: row.id, lastClaimedAt: row.lastClaimedAt },
      data: { lastClaimedAt: tick.now, nextRunAt: tick.nextRunAt },
    }));
  } catch (error) {
    // One row's write failing must cost that row only, not the batch.
    logError(`claim write failed alert=${row.id} project=${row.projectId}`, error);
    return null;
  }
  if (count !== 1) return null;

  // Claim before parse: an unevaluable row still needs `nextRunAt` advanced, or it stays due.
  const rule = parseAlertRule(row);
  if (rule === null) {
    logError(`unevaluable rule parked alert=${row.id} project=${row.projectId}`);
    // No later tick can read what this one could not, so the row is parked
    // rather than re-read and discarded every minute. The reason travels with
    // it: parked without one is a rule that stopped for no stated cause.
    try {
      const parked = await parkAlertRule({
        alertId: row.id,
        claimStamp: tick.now,
        error: { message: UNEVALUABLE_RULE_ERROR, at: new Date() },
      });
      if (!parked) logInfo(`stale claim discarded alert=${row.id} project=${row.projectId}`);
    } catch (error) {
      logError(`park failed alert=${row.id} project=${row.projectId}`, error);
    }
    return null;
  }
  return { rule, claimStamp: tick.now };
}

/** Relies on `Map` keeping the scan's oldest-due-first order, so the longest waiter leads. */
function shareBudgetAcrossProjects<T extends { readonly projectId: string }>(
  rows: readonly T[],
  budget: number,
): T[] {
  const byProject = new Map<string, T[]>();
  for (const row of rows) {
    const queued = byProject.get(row.projectId);
    if (queued === undefined) byProject.set(row.projectId, [row]);
    else queued.push(row);
  }

  const queues = [...byProject.values()];
  const selected: T[] = [];
  for (let depth = 0; selected.length < budget; depth += 1) {
    let dealt = false;
    for (const queue of queues) {
      if (depth >= queue.length) continue;
      selected.push(queue[depth] as T);
      dealt = true;
      if (selected.length >= budget) break;
    }
    if (!dealt) break;
  }
  return selected;
}

/** The conditional update is the mutex: only the claim whose `lastClaimedAt` still holds wins. */
export async function claimDueAlerts(tick: AlertTick): Promise<ClaimedAlert[]> {
  const due = await prisma.alert.findMany({
    where: {
      status: ACTIVE,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: tick.now } }],
      // Deletion is soft, so no cascade fires: without this a deleted project keeps paging.
      project: { deleteTime: null },
    },
    orderBy: [{ nextRunAt: "asc" }, { createTime: "asc" }],
    take: ALERT_CLAIM_SCAN_LIMIT,
  });

  const settled = await mapWithConcurrency(
    shareBudgetAcrossProjects(due, ALERT_CLAIM_LIMIT),
    ALERT_CLAIM_CONCURRENCY,
    (row) => claimRow(row, tick),
  );

  return settled.filter((claim): claim is ClaimedAlert => claim !== null);
}

export interface AlertCompletion {
  readonly alertId: string;
  readonly claimStamp: Date;
  /**
   * The `alertedAt` the transition was decided from. Half of the CAS below, and
   * the half a compensation moves.
   */
  readonly previousAlertedAt: Date | null;
  readonly state: AlertRuntimeState;
  readonly evaluatedAt: Date;
  /** Omitting it is the claim that the run succeeded, which clears the last error. */
  readonly error?: AlertErrorRecord;
}

export interface AlertErrorRecord {
  readonly message: string;
  readonly at: Date;
}

export interface AlertFailureRecord {
  readonly alertId: string;
  readonly claimStamp: Date;
  readonly error: AlertErrorRecord;
}

/** What became of the last notification. Absent means none has been attempted. */
export const ALERT_NOTIFY_STATUSES = ["DELIVERED", "COMPENSATED", "FAILED", "SUPERSEDED"] as const;
export type AlertNotifyStatus = (typeof ALERT_NOTIFY_STATUSES)[number];

export interface AlertNotifyOutcome {
  readonly alertId: string;
  readonly status: AlertNotifyStatus;
  readonly error: string | null;
  readonly at: Date;
  /**
   * Only record if nothing has been recorded since this instant. Set by an outcome
   * that reports on an emission the rule has already replaced: those settle out of
   * order, and a page that did deliver must not be made to read as undelivered by a
   * straggler behind it.
   */
  readonly notAfter?: Date;
}

/** These errors can carry a whole serialized body, and this text is read in a table cell. */
const ERROR_TEXT_MAX = 500;

function truncate(message: string): string {
  return message.length <= ERROR_TEXT_MAX ? message : `${message.slice(0, ERROR_TEXT_MAX - 3)}...`;
}

/**
 * The CAS checks the claim token and ACTIVE together, so a rule re-claimed or paused
 * mid-evaluation takes no write rather than a stale severity. False means "do not notify".
 *
 * `alertedAt` joins them because the claim token does not see a compensation:
 * `revertAlertEmissionState` deliberately leaves the token alone, so a rollback that
 * lands while this tick is at the evaluator would otherwise be overwritten by a
 * transition decided from the state it just retracted — and with renotify off that
 * breach is then never announced at all. It is `alertedAt` and not the severity
 * because a renotify emission and its rollback move only this field, and because it
 * is read from the row rather than parsed, so a severity string this build cannot
 * read cannot wedge the rule.
 */
export async function completeAlertEvaluation(completion: AlertCompletion): Promise<boolean> {
  const { count } = await prisma.alert.updateMany({
    where: {
      id: completion.alertId,
      status: ACTIVE,
      lastClaimedAt: completion.claimStamp,
      alertedAt: completion.previousAlertedAt,
    },
    data: {
      severity: completion.state.severity,
      severityChangedAt: completion.state.severityChangedAt,
      alertedAt: completion.state.alertedAt,
      lastEvaluatedAt: completion.evaluatedAt,
      lastError: completion.error === undefined ? null : truncate(completion.error.message),
      lastErrorAt: completion.error?.at ?? null,
    },
  });
  return count === 1;
}

/**
 * Under the completion's CAS, so a rule a later tick re-claimed keeps that tick's result.
 * `lastEvaluatedAt` is deliberately left alone: a failed run is not an evaluation.
 */
export async function recordAlertEvaluationFailure(failure: AlertFailureRecord): Promise<boolean> {
  const { count } = await prisma.alert.updateMany({
    where: { id: failure.alertId, status: ACTIVE, lastClaimedAt: failure.claimStamp },
    data: { lastError: truncate(failure.error.message), lastErrorAt: failure.error.at },
  });
  return count === 1;
}

/**
 * Records the failure and stops the rule, for the failures no retry can clear:
 * the stored spec itself is one this build cannot evaluate. Same CAS as the
 * plain failure record — a rule a later tick re-claimed, or one the owner
 * paused mid-evaluation, is not this tick's to park — and `nextRunAt` is left
 * where the claim put it, so an edit that re-arms the rule finds it due.
 */
export async function parkAlertRule(failure: AlertFailureRecord): Promise<boolean> {
  const { count } = await prisma.alert.updateMany({
    where: { id: failure.alertId, status: ACTIVE, lastClaimedAt: failure.claimStamp },
    data: {
      status: PARKED,
      lastError: truncate(failure.error.message),
      lastErrorAt: failure.error.at,
    },
  });
  return count === 1;
}

export interface AlertEmissionRevert {
  readonly alertId: string;
  readonly emittedSeverity: AlertSeverity;
  /** The `alertedAt` the emission wrote, which with the severity is the CAS. */
  readonly emittedAt: Date;
  readonly priorState: AlertRuntimeState;
  readonly error: AlertErrorRecord;
}

/**
 * The CAS is the pair of fields the emission moved, not the claim token: every tick
 * re-claims every ACTIVE rule, so that token goes stale within the minute while
 * delivery retries for half an hour. `lastEvaluatedAt` is left where the later ticks
 * put it — those runs happened.
 */
export async function revertAlertEmissionState(revert: AlertEmissionRevert): Promise<boolean> {
  const { count } = await prisma.alert.updateMany({
    where: {
      id: revert.alertId,
      status: ACTIVE,
      severity: revert.emittedSeverity,
      alertedAt: revert.emittedAt,
    },
    data: {
      severity: revert.priorState.severity,
      severityChangedAt: revert.priorState.severityChangedAt,
      alertedAt: revert.priorState.alertedAt,
      lastError: truncate(revert.error.message),
      lastErrorAt: revert.error.at,
    },
  });
  return count === 1;
}

/**
 * No CAS: delivery is a fact about the message, not about who holds the claim. It never
 * throws either — a rejected bookkeeping write on the sent path would page the user twice.
 */
export async function recordAlertNotifyOutcome(outcome: AlertNotifyOutcome): Promise<void> {
  try {
    const { count } = await prisma.alert.updateMany({
      where: {
        id: outcome.alertId,
        ...(outcome.notAfter === undefined
          ? {}
          : { OR: [{ lastNotifyAt: null }, { lastNotifyAt: { lt: outcome.notAfter } }] }),
      },
      data: {
        lastNotifyStatus: outcome.status,
        lastNotifyError: outcome.error === null ? null : truncate(outcome.error),
        lastNotifyAt: outcome.at,
      },
    });
    // Either the rule is gone, or a newer notification already reported: do not
    // let a no-op look like a landed write.
    if (count === 0) {
      logInfo(`notify outcome not recorded alert=${outcome.alertId} status=${outcome.status}`);
    }
  } catch (error) {
    logError(
      `notify outcome write failed alert=${outcome.alertId} status=${outcome.status}`,
      error,
    );
  }
}
