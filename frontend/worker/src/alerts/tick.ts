import { ALERT_EVALUATION_OFFSET_MS, windowToMs, type AlertWindow } from "@traceroot/core";

export const ALERT_TICK_CRON = "* * * * *";
export const ALERT_TICK_MS = 60_000;

export interface AlertTick {
  readonly now: Date;
  readonly boundary: Date;
  readonly windowEnd: Date;
  readonly nextRunAt: Date;
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
    nextRunAt: new Date(boundary.getTime() + ALERT_TICK_MS),
  };
}

export function alertWindowStart(tick: AlertTick, window: AlertWindow): Date {
  return new Date(tick.windowEnd.getTime() - windowToMs(window));
}
