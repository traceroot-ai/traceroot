import {
  ALERT_WINDOWS,
  Prisma,
  prisma,
  type AlertSeverity,
  type AlertStatus,
} from "@traceroot/core";
import { logError, logInfo } from "./log.js";
import { parseAlertRule, type AlertRowLike, type AlertRule } from "./rule.js";
import type { AlertRuntimeState } from "./state-machine.js";
import { alertNextRunAt, type AlertTick } from "./tick.js";

const ACTIVE: AlertStatus = "ACTIVE";

/**
 * Leftovers lead the next tick only while the due set fits `ALERT_CLAIM_SCAN_LIMIT`:
 * a project whose due rules all sort past the scan cap is not seen by the tick at all.
 */
export const ALERT_CLAIM_LIMIT = 500;

/** Headroom over the budget: read exactly the budget and one project's backlog fills it. */
export const ALERT_CLAIM_SCAN_LIMIT = ALERT_CLAIM_LIMIT * 2;

export interface ClaimedAlert {
  readonly rule: AlertRule;
  /** The `lastClaimedAt` this tick wrote; the write-back CAS matches on it. */
  readonly claimStamp: Date;
}

/** Says what the owner can do about it: nothing else on the row will. */
const UNEVALUABLE_RULE_ERROR =
  "this rule's saved settings cannot be evaluated by the running build, so it will not fire; " +
  "open it and save it again to correct them";

/**
 * These columns are `timestamp without time zone` holding UTC, so binding the
 * instant as text and casting reads it back as that same wall clock whatever the
 * session's `TimeZone` is set to.
 */
function utc(instant: Date): Prisma.Sql {
  return Prisma.sql`${instant.toISOString()}::timestamp`;
}

/** Anything `ALERT_WINDOWS` does not hold; they all take the same fallback cadence. */
const UNREADABLE_WINDOW = "";

/**
 * The re-arm per window token, as whole instants rather than arithmetic in SQL.
 * `tick.boundary` is fixed for the tick and the token set is small, so the cadence
 * stays defined once in `alertNextRunAt` and the statement only picks between its
 * answers. `ELSE` is the unreadable-window fallback, which keeps the tick's cadence.
 */
function nextRunAtCase(tick: AlertTick): Prisma.Sql {
  const branches = Object.keys(ALERT_WINDOWS).map(
    (window) => Prisma.sql`WHEN ${window} THEN ${utc(alertNextRunAt(tick, window))}`,
  );
  return Prisma.sql`CASE "window" ${Prisma.join(branches, " ")} ELSE ${utc(
    alertNextRunAt(tick, UNREADABLE_WINDOW),
  )} END`;
}

/**
 * Select, claim and read back the batch in one statement, because the claim is one
 * write per due rule and a full tick is 500 of them: as `findMany` plus a CAS per
 * row that was 500 round-trips a minute against the pool the detector consumers
 * share.
 *
 * `row_number()` is the round-robin: dealing by depth before due time takes one rule
 * from every project in the scan before any project takes a second, so a project
 * whose backlog could fill the budget on its own cannot. Nulls sort last, as they do
 * today — ordering them first put every rule created since the last tick ahead of
 * every rule that was actually due.
 *
 * `FOR UPDATE SKIP LOCKED` replaces the per-row CAS on `lastClaimedAt` as the mutex,
 * and it has to sit in its own scan because a locking clause cannot share a query
 * level with a window function. `MATERIALIZED` so the lock is taken once, over the
 * chosen set, rather than folded back into the `UPDATE`.
 *
 * `locked` repeats the `due` predicate rather than trusting `picked`'s membership:
 * `picked` was read from a snapshot taken at the *start* of this statement, and
 * SKIP LOCKED alone only excludes a row a concurrent tick is still holding, not one
 * a concurrent tick already claimed and committed before this statement reached its
 * own lock. Postgres re-evaluates a `FOR UPDATE` query's own WHERE clause against the
 * row's latest committed version before granting the lock (`READ COMMITTED`'s
 * `EvalPlanQual`) — so restating the predicate here, on the exact scan doing the
 * locking, is what makes a row an intervening commit already re-armed drop out,
 * rather than being claimed a second time on top of it. Losing that race costs a
 * tick fewer than the budget, same as losing the old CAS did.
 *
 * `"window"` and `"view"` are quoted because both are reserved words.
 */
function claimStatement(tick: AlertTick): Prisma.Sql {
  return Prisma.sql`
    WITH due AS (
      SELECT
        a.id,
        a.next_run_at,
        a.create_time,
        row_number() OVER (
          PARTITION BY a.project_id
          ORDER BY a.next_run_at ASC, a.create_time ASC
        ) AS depth
      FROM alerts a
      -- Deletion is soft, so no cascade fires: without this a deleted project keeps paging.
      JOIN projects p ON p.id = a.project_id AND p.delete_time IS NULL
      WHERE a.status = ${ACTIVE}
        AND (a.next_run_at IS NULL OR a.next_run_at <= ${utc(tick.now)})
      ORDER BY a.next_run_at ASC, a.create_time ASC
      LIMIT ${ALERT_CLAIM_SCAN_LIMIT}
    ),
    picked AS (
      SELECT id FROM due
      ORDER BY depth ASC, next_run_at ASC, create_time ASC
      LIMIT ${ALERT_CLAIM_LIMIT}
    ),
    locked AS MATERIALIZED (
      SELECT id FROM alerts
      WHERE id IN (SELECT id FROM picked)
        AND status = ${ACTIVE}
        AND (next_run_at IS NULL OR next_run_at <= ${utc(tick.now)})
      FOR UPDATE SKIP LOCKED
    )
    UPDATE alerts SET
      last_claimed_at = ${utc(tick.now)},
      next_run_at = ${nextRunAtCase(tick)}
    WHERE id IN (SELECT id FROM locked)
    RETURNING
      id,
      project_id AS "projectId",
      name,
      "view",
      measure,
      aggregation,
      filters,
      "window",
      threshold_operator AS "thresholdOperator",
      threshold,
      renotify,
      no_data_mode AS "noDataMode",
      severity,
      severity_changed_at AS "severityChangedAt",
      alerted_at AS "alertedAt"
  `;
}

/**
 * One write for the whole set: every unevaluable row carries the same reason under
 * the same claim stamp, so there is nothing per-row to say. Under the completion's
 * CAS, so a rule a later tick re-claimed keeps that tick's result.
 *
 * There is no parked status, so these rows are re-read and discarded every cadence.
 * Leaving the reason on them is the only sign the owner gets that the severity they
 * are reading is frozen and no run will ever move it.
 */
async function recordUnevaluable(ids: readonly string[], tick: AlertTick): Promise<void> {
  try {
    const { count } = await prisma.alert.updateMany({
      where: { id: { in: [...ids] }, status: ACTIVE, lastClaimedAt: tick.now },
      data: { lastError: UNEVALUABLE_RULE_ERROR, lastErrorAt: new Date() },
    });
    if (count !== ids.length) logInfo(`stale claims discarded count=${ids.length - count}`);
  } catch (error) {
    // The batch's good claims must not be lost to a failed bookkeeping write.
    logError(`error record failed alerts=${ids.length}`, error);
  }
}

export async function claimDueAlerts(tick: AlertTick): Promise<ClaimedAlert[]> {
  const claimed = await prisma.$queryRaw<AlertRowLike[]>(claimStatement(tick));

  // Claim before parse: an unevaluable row still needs `nextRunAt` advanced, or it
  // stays due. The statement above advances it off the raw `window` column for that
  // reason — the claim lands before anything has read the rule.
  const claims: ClaimedAlert[] = [];
  const unevaluable: string[] = [];
  for (const row of claimed) {
    const rule = parseAlertRule(row);
    if (rule === null) {
      logError(`unevaluable rule discarded alert=${row.id} project=${row.projectId}`);
      unevaluable.push(row.id);
    } else {
      claims.push({ rule, claimStamp: tick.now });
    }
  }
  if (unevaluable.length > 0) await recordUnevaluable(unevaluable, tick);

  return claims;
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
