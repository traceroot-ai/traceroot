import cron from "node-cron";
import type { AlertWindow } from "@traceroot/core";
import { enqueueAlertClose, enqueueAlertNotification } from "../notifications/alert-slack.js";
import {
  claimDueAlerts,
  completeAlertEvaluation,
  parkAlertRule,
  readPendingAlertCloses,
  recordAlertEvaluationFailure,
  restoreAlertPendingClose,
  takeAlertPendingClose,
  type ClaimedAlert,
  type DiscardedAlertPage,
} from "./claim.js";
import { mapWithConcurrency } from "./concurrency.js";
import { isAwaitingRedelivery } from "./delivery.js";
import { revertAlertEmission } from "./emission.js";
import {
  evaluateAlerts,
  isSendableAlertSpec,
  ALERT_EVALUATION_CHUNK_SIZE,
  ALERT_EVALUATION_CONCURRENCY,
  type AlertEvaluationResult,
  type AlertEvaluationSpec,
} from "./evaluator-client.js";
import { logError, logInfo } from "./log.js";
import { applyAlertStateMachine, deriveAlertSeverity } from "./severity-state-machine.js";
import { alertWindowStart, computeAlertTick, ALERT_TICK_CRON, type AlertTick } from "./tick.js";

/** One request carries one window pair, so the window token joins the key. */
interface AlertGroup {
  readonly projectId: string;
  readonly window: AlertWindow;
  readonly claims: readonly ClaimedAlert[];
}

const ALERTS_ENABLED_BY_DEFAULT = true;
const ALERTS_ENABLED_TRUTHY = ["true", "1", "yes", "on"];
const ALERTS_ENABLED_FALSY = ["false", "0", "no", "off"];

/**
 * On by default; "false", "0", "no" or "off" turn it off. A spelling this
 * cannot read is reported loudly and then treated as off: setting this at all
 * is a deliberate act and the only reason to reach for it mid-incident is to
 * stop the paging. It stays a log rather than a throw because this is read at
 * boot beside three unrelated workers, and throwing took all of them down.
 *
 * The tick re-reads it rather than holding the value it booted with, so the
 * scheduler always runs on the current one and an unreadable spelling keeps
 * saying so once a minute. Two limits worth stating plainly rather than
 * leaving to be discovered mid-incident: the value comes from the process
 * environment, so under compose it changes only when the worker container is
 * recreated — switching it off there is a redeploy of this one service, brief
 * but real for the three detector consumers that share it; and notifications
 * already queued still deliver on their own retry budget, because the delivery
 * consumer is gated at boot alone.
 */
export function isAlertsSchedulerEnabled(
  value: string | undefined = process.env.ALERTS_SCHEDULER_ENABLED,
): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "") return ALERTS_ENABLED_BY_DEFAULT;
  if (ALERTS_ENABLED_TRUTHY.includes(normalized)) return true;
  if (ALERTS_ENABLED_FALSY.includes(normalized)) return false;

  logError(
    `ALERTS_SCHEDULER_ENABLED must be one of "true"/"1"/"yes"/"on" or ` +
      `"false"/"0"/"no"/"off", got "${value}" — alerting is off until it is corrected.`,
  );
  return false;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) return items.length === 0 ? [] : [[...items]];
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function groupClaims(claims: readonly ClaimedAlert[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const claim of claims) {
    const key = `${claim.rule.projectId}|${claim.rule.window}`;
    const existing = groups.get(key);
    groups.set(
      key,
      existing === undefined
        ? { projectId: claim.rule.projectId, window: claim.rule.window, claims: [claim] }
        : { ...existing, claims: [...existing.claims, claim] },
    );
  }
  return [...groups.values()];
}

function toSpec(claim: ClaimedAlert): AlertEvaluationSpec {
  return {
    alert_id: claim.rule.id,
    view: claim.rule.view,
    measure: claim.rule.measure,
    aggregation: claim.rule.aggregation,
    filters: claim.rule.filters,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failure the owner cannot see is a rule that reports its last good severity
 * forever, so every path that gives up on a run leaves the reason on the row.
 * The write is guarded because these paths are already the failing ones.
 */
async function recordFailure(claim: ClaimedAlert, message: string): Promise<void> {
  const { rule } = claim;
  try {
    const recorded = await recordAlertEvaluationFailure({
      alertId: rule.id,
      claimStamp: claim.claimStamp,
      error: { message, at: new Date() },
    });
    if (!recorded) logInfo(`stale claim discarded alert=${rule.id} project=${rule.projectId}`);
  } catch (error) {
    logError(`error record failed alert=${rule.id} project=${rule.projectId}`, error);
  }
}

/** What the owner has to do about a parked rule, appended to the evaluator's reason. */
const PARKED_RULE_SUFFIX =
  "; this rule is parked and will not run again until it is edited and saved, or resumed";

/**
 * A rejection of the rule itself, which every later tick would reject the same
 * way. Parking is the whole point of telling the two apart, so a park that does
 * not land falls back to recording the failure: a rule left ACTIVE is retried
 * needlessly, which is the pre-existing behaviour and not a silent stop.
 */
async function parkRule(claim: ClaimedAlert, message: string): Promise<void> {
  const { rule } = claim;
  try {
    const parked = await parkAlertRule({
      alertId: rule.id,
      claimStamp: claim.claimStamp,
      error: { message: `${message}${PARKED_RULE_SUFFIX}`, at: new Date() },
    });
    if (!parked) logInfo(`stale claim discarded alert=${rule.id} project=${rule.projectId}`);
  } catch (error) {
    logError(`park failed alert=${rule.id} project=${rule.projectId}`, error);
    await recordFailure(claim, message);
  }
}

/** This tick's closes still to be sent, by rule. A page that takes one removes it. */
type PendingCloses = Map<string, DiscardedAlertPage>;

/** Closes go out beside the evaluations, so they share a bound of the same order. */
const ALERT_CLOSE_CONCURRENCY = ALERT_EVALUATION_CONCURRENCY;

/** A failed read costs this tick its closes and nothing else: the markers stay put. */
async function readPendingCloses(): Promise<PendingCloses> {
  try {
    const pages = await readPendingAlertCloses();
    return new Map(pages.map((page) => [page.alertId, page]));
  } catch (error) {
    logError("close read failed, closes wait for the next tick", error);
    return new Map();
  }
}

/**
 * Taking the marker is the conditional write that decides who sends, so two ticks
 * cannot both close the same page. False covers a take that failed as well as one
 * that lost: either way this caller does not own the close.
 */
async function takeClose(page: DiscardedAlertPage): Promise<boolean> {
  try {
    return await takeAlertPendingClose(page.alertId, page.pendingClose);
  } catch (error) {
    logError(`close take failed alert=${page.alertId} project=${page.projectId}`, error);
    return false;
  }
}

async function restoreClose(page: DiscardedAlertPage): Promise<void> {
  try {
    await restoreAlertPendingClose(page.alertId, page.pendingClose);
  } catch (error) {
    logError(`close restore failed alert=${page.alertId} project=${page.projectId}`, error);
  }
}

/**
 * The close of a page whose rule announced nothing this tick: it recovered under the
 * new rule, was not evaluated, or is not running at all. A close that could not be
 * queued is put back for the next tick, the same write-then-enqueue order an
 * emission follows. Never throws.
 */
async function sendCloseAlone(page: DiscardedAlertPage): Promise<void> {
  if (!(await takeClose(page))) return;
  try {
    await enqueueAlertClose({
      alertId: page.alertId,
      projectId: page.projectId,
      name: page.name,
      ...page.pendingClose,
    });
  } catch (error) {
    logError(
      `close enqueue failed, putting it back alert=${page.alertId} project=${page.projectId}`,
      error,
    );
    await restoreClose(page);
  }
}

async function settleClaim(
  claim: ClaimedAlert,
  result: AlertEvaluationResult | undefined,
  tick: AlertTick,
  windowStart: Date,
  closes: PendingCloses,
): Promise<void> {
  const { rule } = claim;
  if (result === undefined) {
    logError(`no result returned alert=${rule.id} project=${rule.projectId}`);
    await recordFailure(claim, "the evaluator returned no result for this rule");
    return;
  }
  if (result.error !== null) {
    logError(`evaluation error alert=${rule.id} project=${rule.projectId}: ${result.error}`);
    // A spec the evaluator refuses is refused on the rule's stored settings, not
    // on this window's data: retrying it is the loop the parked status exists to
    // end. Every other failure stays a retry.
    if (result.errorKind === "spec") await parkRule(claim, result.error);
    else await recordFailure(claim, result.error);
    return;
  }

  const severity = deriveAlertSeverity(
    result.value,
    rule.thresholdOperator,
    rule.threshold,
    rule.noDataMode,
  );
  const decided = applyAlertStateMachine(
    rule.state,
    severity,
    tick.boundary,
    rule.renotify,
    rule.noDataMode,
    rule.window,
  );
  // The standing page never reached anyone and can now: send it, as the emission it
  // always should have been, so it is stamped and compensated like one.
  const isRedelivery = !decided.emit && isAwaitingRedelivery(rule, severity);
  const transition = isRedelivery
    ? { emit: true, nextState: { ...decided.nextState, alertedAt: tick.boundary } }
    : decided;

  const written = await completeAlertEvaluation({
    alertId: rule.id,
    claimStamp: claim.claimStamp,
    // What this transition was decided from. A delivery that gave up while the
    // evaluator was answering has already put the rule back to where it was
    // before the emission, and that rollback outranks this result.
    previousAlertedAt: rule.state.alertedAt,
    state: transition.nextState,
    evaluatedAt: tick.boundary,
  });
  if (!written) {
    logInfo(`stale claim discarded or state moved alert=${rule.id} project=${rule.projectId}`);
    return;
  }

  if (!transition.emit) return;
  if (isRedelivery) {
    logInfo(
      `re-paging an undelivered page alert=${rule.id} project=${rule.projectId} ` +
        `reason=${rule.lastDelivery.error}`,
    );
  }

  // A page raised over a close still waiting carries that close with it, to be
  // posted first by the one job. Sent apart they race on the consumer, and a page
  // that wins reads in the channel as the alert the close then ends.
  const discarded = closes.get(rule.id);
  closes.delete(rule.id);
  const carried = discarded !== undefined && (await takeClose(discarded)) ? discarded : undefined;

  // Write-then-enqueue, deliberately: the reverse order pages first and records
  // second, so a crash between them repeats a page the operator already saw.
  // The cost is a breach recorded but never announced, so a failed enqueue
  // restores the pre-evaluation state for the next tick to re-emit.
  try {
    await enqueueAlertNotification({
      alertId: rule.id,
      projectId: rule.projectId,
      name: rule.name,
      severity,
      previousSeverity: rule.state.severity,
      value: result.value,
      threshold: rule.threshold,
      thresholdOperator: rule.thresholdOperator,
      measure: rule.measure,
      aggregation: rule.aggregation,
      window: rule.window,
      windowStart,
      windowEnd: tick.windowEnd,
      filters: rule.filters,
      // Travels with the job so a delivery that provably sent nothing can undo
      // this write however many minutes later, matching on what it wrote.
      emission: {
        evaluatedAt: tick.boundary.getTime(),
        priorSeverity: rule.state.severity,
        priorSeverityChangedAt: rule.state.severityChangedAt?.getTime() ?? null,
        priorAlertedAt: rule.state.alertedAt?.getTime() ?? null,
      },
      closeFirst: carried?.pendingClose,
    });
  } catch (error) {
    logError(
      `notification enqueue failed, reverting state alert=${rule.id} project=${rule.projectId} severity=${severity}`,
      error,
    );
    await revertAlertEmission(
      {
        alertId: rule.id,
        emittedSeverity: severity,
        emittedAt: tick.boundary,
        priorState: rule.state,
      },
      rule.projectId,
      "enqueue-failed",
    );
    // The close went down with the page it rode on, so it goes back with it.
    if (carried !== undefined) await restoreClose(carried);
  }
}

async function evaluateBatch(
  group: AlertGroup,
  claims: readonly ClaimedAlert[],
  tick: AlertTick,
  windowStart: Date,
  closes: PendingCloses,
): Promise<void> {
  let results: AlertEvaluationResult[];
  try {
    results = await evaluateAlerts({
      projectId: group.projectId,
      windowStart,
      windowEnd: tick.windowEnd,
      alerts: claims.map(toSpec),
    });
  } catch (error) {
    // Transient ClickHouse or transport failure: the rules stay ACTIVE and the
    // next tick retries them.
    logError(
      `evaluation request failed project=${group.projectId} window=${group.window} rules=${claims.length}`,
      error,
    );
    const message = `evaluation request failed: ${describeError(error)}`;
    for (const claim of claims) {
      await recordFailure(claim, message);
    }
    return;
  }

  const byId = new Map(results.map((result) => [result.alert_id, result]));
  for (const claim of claims) {
    try {
      await settleClaim(claim, byId.get(claim.rule.id), tick, windowStart, closes);
    } catch (error) {
      logError(`settle failed alert=${claim.rule.id} project=${claim.rule.projectId}`, error);
      await recordFailure(claim, `settling this run failed: ${describeError(error)}`);
    }
  }
}

const UNSENDABLE_SPEC_ERROR = "rule uses a filter the evaluator does not accept";

function unsendableResult(claim: ClaimedAlert): AlertEvaluationResult {
  return {
    alert_id: claim.rule.id,
    value: null,
    row_count: 0,
    error: UNSENDABLE_SPEC_ERROR,
    // Decided here rather than asked: the backend would refuse this spec on
    // every tick, which is the same verdict it tags "spec" itself.
    errorKind: "spec",
  };
}

interface SpecPartition {
  readonly sendable: readonly ClaimedAlert[];
  readonly unsendable: readonly ClaimedAlert[];
}

function partitionSendable(claims: readonly ClaimedAlert[]): SpecPartition {
  const sendable: ClaimedAlert[] = [];
  const unsendable: ClaimedAlert[] = [];
  for (const claim of claims) {
    if (isSendableAlertSpec(toSpec(claim))) sendable.push(claim);
    else unsendable.push(claim);
  }
  return { sendable, unsendable };
}

type EvaluationTask = () => Promise<void>;

function groupTasks(group: AlertGroup, tick: AlertTick, closes: PendingCloses): EvaluationTask[] {
  const windowStart = alertWindowStart(tick, group.window);

  // A spec the backend would refuse is that rule's own failure; sending it
  // would fail the request and with it every other rule in the batch.
  const { sendable, unsendable } = partitionSendable(group.claims);

  return [
    ...chunk(sendable, ALERT_EVALUATION_CHUNK_SIZE).map(
      (claims) => () => evaluateBatch(group, claims, tick, windowStart, closes),
    ),
    ...unsendable.map((claim) => async () => {
      try {
        await settleClaim(claim, unsendableResult(claim), tick, windowStart, closes);
      } catch (error) {
        logError(`settle failed alert=${claim.rule.id} project=${claim.rule.projectId}`, error);
        await recordFailure(claim, `settling this run failed: ${describeError(error)}`);
      }
    }),
  ];
}

async function evaluateClaims(
  claims: readonly ClaimedAlert[],
  tick: AlertTick,
  closes: PendingCloses,
): Promise<void> {
  const groups = groupClaims(claims);
  logInfo(
    `tick boundary=${tick.boundary.toISOString()} rules=${claims.length} groups=${groups.length}`,
  );

  // One bound over every group's batches rather than one per group: nested
  // bounds multiply, and it is the total width against the evaluator that
  // decides whether the tick completes or aborts wholesale.
  const tasks = groups.flatMap((group) => groupTasks(group, tick, closes));
  await mapWithConcurrency(tasks, ALERT_EVALUATION_CONCURRENCY, (task) => task());
}

export async function runAlertTick(now: Date): Promise<void> {
  const tick = computeAlertTick(now);

  // Started beside the claim rather than ahead of it: neither waits on the other,
  // and the closes are only needed once a rule settles.
  const closesRead = readPendingCloses();

  let claims: ClaimedAlert[] = [];
  try {
    claims = await claimDueAlerts(tick);
  } catch (error) {
    logError("claim read failed, skipping this tick's evaluations", error);
  }
  const closes = await closesRead;
  if (claims.length > 0) await evaluateClaims(claims, tick, closes);

  // Whatever no page carried goes out by itself, after the evaluations so that a
  // rule that is about to page again is never closed by a job racing that page.
  await mapWithConcurrency([...closes.values()], ALERT_CLOSE_CONCURRENCY, sendCloseAlone);
}

export interface AlertSchedulerHandle {
  readonly stop: () => void;
  /** Resolves true once no tick is in flight, false if the bound expired first. */
  readonly waitForIdle: (timeoutMs: number) => Promise<boolean>;
}

export function startAlertScheduler(): AlertSchedulerHandle | undefined {
  if (!isAlertsSchedulerEnabled()) {
    logInfo('scheduler disabled (set ALERTS_SCHEDULER_ENABLED="true" to run it)');
    return undefined;
  }

  let isTicking = false;
  let isStopped = false;
  let inFlightTick = Promise.resolve();
  let wasEnabled = true;
  const task = cron.schedule(ALERT_TICK_CRON, async () => {
    // node-cron's stop() only clears the timer; a callback already dispatched still runs.
    if (isStopped) return;

    // Read per tick, not held from boot: an operator reaches for this to stop
    // the paging during an incident, and restarting the worker to apply it
    // takes the three detector consumers down with it.
    const isEnabled = isAlertsSchedulerEnabled();
    if (isEnabled !== wasEnabled) {
      logInfo(
        isEnabled ? "scheduler switched back on" : "scheduler switched off, ticks are paused",
      );
      wasEnabled = isEnabled;
    }
    if (!isEnabled) return;

    if (isTicking) {
      logInfo("previous tick still running, skipping this minute");
      return;
    }
    isTicking = true;
    inFlightTick = (async () => {
      try {
        await runAlertTick(new Date());
      } catch (error) {
        logError("tick failed", error);
      } finally {
        isTicking = false;
      }
    })();
    await inFlightTick;
  });

  logInfo(`scheduler started (${ALERT_TICK_CRON})`);
  return {
    stop: () => {
      isStopped = true;
      task.stop();
    },
    waitForIdle: async (timeoutMs: number): Promise<boolean> => {
      if (!isTicking) return true;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          inFlightTick.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
