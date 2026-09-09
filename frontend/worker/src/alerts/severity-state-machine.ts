import {
  DEFAULT_ALERT_NO_DATA_MODE,
  DEFAULT_ALERT_WINDOW,
  windowToMs,
  type AlertNoDataMode,
  type AlertRenotify,
  type AlertSeverity,
  type AlertThresholdOperator,
  type AlertWindow,
} from "@traceroot/core";

export interface AlertRuntimeState {
  readonly severity: AlertSeverity;
  readonly severityChangedAt: Date | null;
  readonly alertedAt: Date | null;
}

export interface AlertTransition {
  readonly emit: boolean;
  readonly nextState: AlertRuntimeState;
}

const MINUTE_MS = 60_000;

/**
 * The longest a gap is allowed to stand unannounced under NOTIFY. Without it a
 * wide rule inherits its own window as the wait, and two hours of not knowing
 * the data stopped is worse than the flapping the debounce is here to stop.
 */
export const ALERT_NO_DATA_DEBOUNCE_CAP_MS = 10 * MINUTE_MS;

export function compareToThreshold(
  value: number,
  operator: AlertThresholdOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "=":
      return value === threshold;
    case "!=":
      return value !== threshold;
  }
}

export function deriveAlertSeverity(
  value: number | null,
  operator: AlertThresholdOperator,
  threshold: number,
  noDataMode: AlertNoDataMode = DEFAULT_ALERT_NO_DATA_MODE,
): AlertSeverity {
  if (value !== null && Number.isFinite(value)) {
    return compareToThreshold(value, operator, threshold) ? "ALERT" : "OK";
  }
  // ZERO reads a window that measured nothing as a window that measured zero,
  // so the threshold still decides and NO_DATA never arises.
  if (noDataMode !== "ZERO") return "NO_DATA";
  return compareToThreshold(0, operator, threshold) ? "ALERT" : "OK";
}

function shouldRenotify(previous: AlertRuntimeState, now: Date, renotify: AlertRenotify): boolean {
  if (renotify.mode !== "EVERY") return false;
  // A null `alertedAt` means the entry into ALERT was itself silent: without
  // this guard such a rule renotifies on the very next tick.
  if (previous.alertedAt === null) return false;
  return now.getTime() - previous.alertedAt.getTime() >= renotify.intervalMinutes * MINUTE_MS;
}

/**
 * A breach that has been announced and not yet recovered. In ALERT it is the
 * emission that put the rule there; in NO_DATA it is the one `nextAlertedAt`
 * carried across the gap, which is what lets a rule leaving NO_DATA tell a
 * recovery from a first reading.
 */
function hasOutstandingPage(previous: AlertRuntimeState): boolean {
  return (
    (previous.severity === "ALERT" || previous.severity === "NO_DATA") &&
    previous.alertedAt !== null
  );
}

/**
 * How long a gap must stand before NOTIFY pages it, read off the rule's own
 * window because that is the span it judges over: a 1m rule reads empty on any
 * quiet minute, where a 2h rule reading empty has already watched two hours of
 * silence. Capped by `ALERT_NO_DATA_DEBOUNCE_CAP_MS`.
 */
function noDataDebounceMs(window: AlertWindow): number {
  return Math.min(windowToMs(window), ALERT_NO_DATA_DEBOUNCE_CAP_MS);
}

/**
 * Whether the page that stands was raised for the stretch the rule is in now
 * rather than carried in from the severity before it. `severityChangedAt` opens
 * the stretch and every emission stamps `alertedAt`, so an `alertedAt` older
 * than the change belongs to a breach the rule has since left. A rule that has
 * never held a severity long enough to have a change has nothing carried in.
 */
function pagedThisStretch(previous: AlertRuntimeState): boolean {
  if (previous.alertedAt === null) return false;
  if (previous.severityChangedAt === null) return true;
  return previous.alertedAt.getTime() >= previous.severityChangedAt.getTime();
}

/** A gap that has outlasted its rule's debounce, and so is an incident. */
function gapIsSettled(previous: AlertRuntimeState, now: Date, window: AlertWindow): boolean {
  // No entry clock means no way to time the gap; announcing it beats sitting on
  // it forever, which is what a debounce measured from nothing would do.
  if (previous.severityChangedAt === null) return true;
  return now.getTime() - previous.severityChangedAt.getTime() >= noDataDebounceMs(window);
}

function shouldEmit(
  previous: AlertRuntimeState,
  severity: AlertSeverity,
  now: Date,
  renotify: AlertRenotify,
  noDataMode: AlertNoDataMode,
  window: AlertWindow,
): boolean {
  // UNKNOWN is never an evaluated outcome, under any reading of a gap.
  if (severity === "UNKNOWN") return false;
  if (noDataMode === "NOTIFY") {
    // The silence is the incident, but only once it has stood long enough to be
    // one. On a low-traffic project a single empty window is ordinary, so entry
    // is silent, the page waits for the gap to settle, and it then repeats on
    // renotify's terms.
    if (severity === "NO_DATA") {
      if (previous.severity !== "NO_DATA") return false;
      if (pagedThisStretch(previous)) return shouldRenotify(previous, now, renotify);
      return gapIsSettled(previous, now, window);
    }
    // Any reading at all ends the silence, but only a gap somebody was paged
    // for has an all-clear to give: one that never settled ends as quietly as
    // it began, or the flapping just changes which message it flaps with. A
    // breach on the far side is news either way.
    if (previous.severity === "NO_DATA") {
      return severity === "ALERT" || hasOutstandingPage(previous);
    }
  }
  // Under every other reading a gap judges nothing, so it says nothing.
  if (severity === "NO_DATA") return false;
  if (hasOutstandingPage(previous)) {
    // OK ends the breach the user was paged for, whether or not the source
    // dropped out on the way. ALERT is that same breach still standing, so a
    // source flapping through NO_DATA repeats itself only when renotify says to.
    return severity === "OK" || shouldRenotify(previous, now, renotify);
  }
  // With nothing outstanding only a fresh breach speaks: recovery into OK would
  // announce an all-clear nobody was waiting on.
  return severity === "ALERT" && previous.severity !== "ALERT";
}

function nextAlertedAt(
  previous: AlertRuntimeState,
  severity: AlertSeverity,
  emit: boolean,
  now: Date,
): Date | null {
  if (emit) return now;
  // A gap holds an outstanding page open and drops anything else, so the quiet
  // stretch after a recovery cannot be mistaken for a breach waiting to clear.
  if (severity === "NO_DATA") return hasOutstandingPage(previous) ? previous.alertedAt : null;
  return previous.alertedAt;
}

/** Callers pass the tick's clock so every rule in a tick shares one `now`. */
export function applyAlertStateMachine(
  previous: AlertRuntimeState,
  severity: AlertSeverity,
  now: Date,
  renotify: AlertRenotify,
  noDataMode: AlertNoDataMode = DEFAULT_ALERT_NO_DATA_MODE,
  window: AlertWindow = DEFAULT_ALERT_WINDOW,
): AlertTransition {
  const emit = shouldEmit(previous, severity, now, renotify, noDataMode, window);
  return {
    emit,
    nextState: {
      severity,
      // Two clocks, deliberately separate: `severityChangedAt` moves only on a
      // severity change, `alertedAt` only on an emission or the gap that ends
      // one. Renotify reads `alertedAt`, so collapsing them resets the interval
      // every evaluation.
      severityChangedAt: previous.severity === severity ? previous.severityChangedAt : now,
      alertedAt: nextAlertedAt(previous, severity, emit, now),
    },
  };
}
