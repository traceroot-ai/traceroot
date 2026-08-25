import cron from "node-cron";
import type { AlertWindow } from "@traceroot/core";
import { enqueueAlertNotification } from "../notifications/alert-slack.js";
import {
  claimDueAlerts,
  completeAlertEvaluation,
  recordAlertEvaluationFailure,
  type ClaimedAlert,
  type AlertClaimScope,
} from "./claim.js";
import { mapWithConcurrency } from "./concurrency.js";
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
import { applyAlertStateMachine, deriveAlertSeverity } from "./state-machine.js";
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

async function settleClaim(
  claim: ClaimedAlert,
  result: AlertEvaluationResult | undefined,
  tick: AlertTick,
  windowStart: Date,
): Promise<void> {
  const { rule } = claim;
  if (result === undefined) {
    logError(`no result returned alert=${rule.id} project=${rule.projectId}`);
    await recordFailure(claim, "the evaluator returned no result for this rule");
    return;
  }
  if (result.error !== null) {
    logError(`evaluation error alert=${rule.id} project=${rule.projectId}: ${result.error}`);
    await recordFailure(claim, result.error);
    return;
  }

  const severity = deriveAlertSeverity(
    result.value,
    rule.thresholdOperator,
    rule.threshold,
    rule.noDataMode,
  );
  const transition = applyAlertStateMachine(
    rule.state,
    severity,
    tick.boundary,
    rule.renotify,
    rule.noDataMode,
  );

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
  }
}

async function evaluateBatch(
  group: AlertGroup,
  claims: readonly ClaimedAlert[],
  tick: AlertTick,
  windowStart: Date,
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
      await settleClaim(claim, byId.get(claim.rule.id), tick, windowStart);
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

function groupTasks(group: AlertGroup, tick: AlertTick): EvaluationTask[] {
  const windowStart = alertWindowStart(tick, group.window);

  // A spec the backend would refuse is that rule's own failure; sending it
  // would fail the request and with it every other rule in the batch.
  const { sendable, unsendable } = partitionSendable(group.claims);

  return [
    ...chunk(sendable, ALERT_EVALUATION_CHUNK_SIZE).map(
      (claims) => () => evaluateBatch(group, claims, tick, windowStart),
    ),
    ...unsendable.map((claim) => async () => {
      try {
        await settleClaim(claim, unsendableResult(claim), tick, windowStart);
      } catch (error) {
        logError(`settle failed alert=${claim.rule.id} project=${claim.rule.projectId}`, error);
        await recordFailure(claim, `settling this run failed: ${describeError(error)}`);
      }
    }),
  ];
}

export async function runAlertTick(now: Date, scope?: AlertClaimScope): Promise<void> {
  const tick = computeAlertTick(now);

  let claims: ClaimedAlert[];
  try {
    claims = await claimDueAlerts(tick, scope);
  } catch (error) {
    logError("claim read failed, skipping this tick", error);
    return;
  }
  if (claims.length === 0) return;

  const groups = groupClaims(claims);
  logInfo(
    `tick boundary=${tick.boundary.toISOString()} rules=${claims.length} groups=${groups.length}`,
  );

  // One bound over every group's batches rather than one per group: nested
  // bounds multiply, and it is the total width against the evaluator that
  // decides whether the tick completes or aborts wholesale.
  const tasks = groups.flatMap((group) => groupTasks(group, tick));
  await mapWithConcurrency(tasks, ALERT_EVALUATION_CONCURRENCY, (task) => task());
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
