import {
  canonicalizeAlertFilters,
  DEFAULT_ALERT_SEVERITY,
  type AlertFilter,
} from "@traceroot/core";
import { decimalToNumber, type AlertRow } from "./serialize";

/** The parts of a rule an evaluation reads. `name` is deliberately absent. */
export interface AlertRuleSnapshot {
  view: string;
  measure: string;
  aggregation: string;
  filters: readonly AlertFilter[];
  window: string;
  thresholdOperator: string;
  threshold: number;
  noDataMode: string;
}

/**
 * Stored evaluation state describes the rule that produced it, so any edit to
 * the rule voids it. Nulling `lastClaimedAt` also voids the claim CAS, so a
 * worker mid-evaluation on the old rule cannot write its result back. A
 * function, not a constant: `nextRunAt` has to be the moment of the reset,
 * since null sorts behind every scheduled rule on the platform.
 */
export function alertStateReset() {
  return {
    severity: DEFAULT_ALERT_SEVERITY,
    severityChangedAt: null,
    alertedAt: null,
    lastEvaluatedAt: null,
    nextRunAt: new Date(),
    lastClaimedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastNotifyStatus: null,
    lastNotifyError: null,
    lastNotifyAt: null,
  };
}

export function toRuleSnapshot(row: AlertRow): AlertRuleSnapshot {
  return {
    view: row.view,
    measure: row.measure,
    aggregation: row.aggregation,
    filters: row.filters as unknown as AlertFilter[],
    window: row.window,
    thresholdOperator: row.thresholdOperator,
    threshold: decimalToNumber(row.threshold),
    noDataMode: row.noDataMode,
  };
}

function areFiltersEqual(a: readonly AlertFilter[], b: readonly AlertFilter[]): boolean {
  return (
    JSON.stringify(canonicalizeAlertFilters(a)) === JSON.stringify(canonicalizeAlertFilters(b))
  );
}

export function hasRuleChanged(
  current: AlertRuleSnapshot,
  update: Partial<AlertRuleSnapshot>,
): boolean {
  if (update.view !== undefined && update.view !== current.view) return true;
  if (update.measure !== undefined && update.measure !== current.measure) return true;
  if (update.aggregation !== undefined && update.aggregation !== current.aggregation) return true;
  if (update.window !== undefined && update.window !== current.window) return true;
  if (
    update.thresholdOperator !== undefined &&
    update.thresholdOperator !== current.thresholdOperator
  ) {
    return true;
  }
  if (update.threshold !== undefined && update.threshold !== current.threshold) return true;
  if (update.noDataMode !== undefined && update.noDataMode !== current.noDataMode) return true;
  if (update.filters !== undefined && !areFiltersEqual(update.filters, current.filters))
    return true;
  return false;
}
