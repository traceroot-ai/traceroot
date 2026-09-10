import {
  DEFAULT_ALERT_NO_DATA_MODE,
  type AlertNoDataMode,
  type AlertRenotify,
  type AlertSeverity,
  type AlertThresholdOperator,
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

function shouldEmit(
  previous: AlertRuntimeState,
  severity: AlertSeverity,
  now: Date,
  renotify: AlertRenotify,
  noDataMode: AlertNoDataMode,
): boolean {
  // UNKNOWN is never an evaluated outcome, under any reading of a gap.
  if (severity === "UNKNOWN") return false;
  if (noDataMode === "NOTIFY") {
    // The silence is the incident: entering it pages once and then on
    // renotify's terms, and any reading at all on the far side ends it.
    if (severity === "NO_DATA") {
      return previous.severity !== "NO_DATA" || shouldRenotify(previous, now, renotify);
    }
    if (previous.severity === "NO_DATA") return true;
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
): AlertTransition {
  const emit = shouldEmit(previous, severity, now, renotify, noDataMode);
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
