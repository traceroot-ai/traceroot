import {
  DEFAULT_ALERT_NO_DATA_MODE,
  clampRenotifyInterval,
  isAlertAggregation,
  isAlertNoDataMode,
  isAlertSeverity,
  isAlertThresholdOperator,
  isAlertView,
  isAlertWindow,
  type AlertAggregation,
  type AlertFilter,
  type AlertNoDataMode,
  type AlertRenotify,
  type AlertThresholdOperator,
  type AlertView,
  type AlertWindow,
} from "@traceroot/core";
import type { AlertRuntimeState } from "./state-machine.js";

/** Structural rather than the Prisma row type, so parsing stays client-free. */
export interface AlertRowLike {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly view: string;
  readonly measure: string;
  readonly aggregation: string;
  readonly filters: unknown;
  readonly window: string;
  readonly thresholdOperator: string;
  readonly threshold: unknown;
  readonly renotify: unknown;
  readonly noDataMode: string;
  readonly severity: string;
  readonly severityChangedAt: Date | null;
  readonly alertedAt: Date | null;
}

export interface AlertRule {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly view: AlertView;
  readonly measure: string;
  readonly aggregation: AlertAggregation;
  readonly filters: readonly AlertFilter[];
  readonly window: AlertWindow;
  readonly thresholdOperator: AlertThresholdOperator;
  readonly threshold: number;
  readonly renotify: AlertRenotify;
  readonly noDataMode: AlertNoDataMode;
  readonly state: AlertRuntimeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `threshold` arrives as a Prisma Decimal, which is neither number nor string. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isRecord(value) && typeof value.toNumber === "function") {
    const parsed = (value.toNumber as () => unknown)();
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseRenotify(value: unknown): AlertRenotify | null {
  if (!isRecord(value)) return null;
  if (value.mode === "OFF") return { mode: "OFF" };
  if (value.mode !== "EVERY") return null;
  const minutes = toFiniteNumber(value.intervalMinutes);
  if (minutes === null) return null;
  return { mode: "EVERY", intervalMinutes: clampRenotifyInterval(minutes) };
}

/** Scalar only, matching `AlertFilterValue`: no set operator exists to read an array. */
function isFilterValue(value: unknown): boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isFilterShaped(entry: unknown): entry is AlertFilter {
  return (
    isRecord(entry) &&
    typeof entry.field === "string" &&
    typeof entry.op === "string" &&
    (entry.key === undefined || typeof entry.key === "string") &&
    isFilterValue(entry.value)
  );
}

/**
 * Null for a stored filter that cannot form a predicate, so the row is dropped
 * after its claim rather than sent on to fail evaluation. There is no parked
 * status, so such a row keeps being read and discarded once a minute.
 */
function parseFilters(value: unknown): readonly AlertFilter[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isFilterShaped)) return null;
  // Rebuilt from the known keys: an extra stored property 422s the whole chunk.
  return value.map((entry) =>
    entry.key === undefined
      ? { field: entry.field, op: entry.op, value: entry.value }
      : { field: entry.field, key: entry.key, op: entry.op, value: entry.value },
  );
}

function parseState(row: AlertRowLike): AlertRuntimeState {
  return {
    severity: isAlertSeverity(row.severity) ? row.severity : "UNKNOWN",
    severityChangedAt: row.severityChangedAt,
    alertedAt: row.alertedAt,
  };
}

/** Null when the stored rule can no longer be evaluated; the caller skips it. */
export function parseAlertRule(row: AlertRowLike): AlertRule | null {
  const threshold = toFiniteNumber(row.threshold);
  const filters = parseFilters(row.filters);
  const renotify = parseRenotify(row.renotify);

  if (
    !isAlertView(row.view) ||
    !isAlertAggregation(row.aggregation) ||
    !isAlertWindow(row.window) ||
    !isAlertThresholdOperator(row.thresholdOperator) ||
    threshold === null ||
    filters === null ||
    renotify === null
  ) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    view: row.view,
    measure: row.measure,
    aggregation: row.aggregation,
    filters,
    window: row.window,
    thresholdOperator: row.thresholdOperator,
    threshold,
    renotify,
    // A mode this build does not know still leaves an evaluable rule, and the
    // default is the reading that decides the least.
    noDataMode: isAlertNoDataMode(row.noDataMode) ? row.noDataMode : DEFAULT_ALERT_NO_DATA_MODE,
    state: parseState(row),
  };
}
