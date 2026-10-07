import {
  ALERT_EVALUATION_OFFSET_MS,
  isAlertWindow,
  windowToMs,
  type AlertWindow,
} from "@traceroot/core";

export const ALERT_TICK_CRON = "* * * * *";
export const ALERT_TICK_MS = 60_000;

/**
 * The longest a rule may wait to be measured again. Past this the saving flattens
 * out — the widest window already sheds 11 of every 12 runs at five minutes —
 * while the delay before a breach is seen keeps growing.
 */
export const ALERT_CADENCE_CAP_MS = 5 * 60_000;

export interface AlertTick {
  readonly now: Date;
  readonly boundary: Date;
  readonly windowEnd: Date;
}

export function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / ALERT_TICK_MS) * ALERT_TICK_MS);
}

/**
 * Edges are derived once per tick from the floored minute boundary rather than
 * per rule from `now`: two rules evaluated in the same tick must compare
 * identical windows against the same data.
 */
export function computeAlertTick(now: Date): AlertTick {
  const boundary = floorToMinute(now);
  return {
    now,
    boundary,
    windowEnd: new Date(boundary.getTime() - ALERT_EVALUATION_OFFSET_MS),
  };
}

export function alertWindowStart(tick: AlertTick, window: AlertWindow): Date {
  return new Date(tick.windowEnd.getTime() - windowToMs(window));
}

/**
 * How long this rule waits before it is measured again. A window answers over
 * its own span of data, so it can only say something new once it holds new data:
 * re-running a 2h rule every minute spends sixty ClickHouse queries an hour to
 * re-read the same spans, and the platform pays that for every wide rule on it.
 *
 * Never longer than the window itself, which is what keeps the schedule lossless
 * — consecutive windows abut at the cap and overlap below it, so no span falls
 * between two evaluations. A window this build cannot read keeps the tick's own
 * cadence: such a row is claimed and discarded every minute either way, and
 * backing it off would only delay the error its owner is waiting to read.
 */
export function alertCadenceMs(window: string): number {
  if (!isAlertWindow(window)) return ALERT_TICK_MS;
  return Math.min(windowToMs(window), ALERT_CADENCE_CAP_MS);
}

/**
 * Measured from the boundary rather than from `now`, so a tick that ran late
 * does not carry its lateness into every following run of the rule.
 */
export function alertNextRunAt(tick: AlertTick, window: string): Date {
  return new Date(tick.boundary.getTime() + alertCadenceMs(window));
}
