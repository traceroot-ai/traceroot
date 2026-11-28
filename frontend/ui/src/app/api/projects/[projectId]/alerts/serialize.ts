import { Prisma } from "@prisma/client";
import type { AlertFilter, AlertRenotify } from "@traceroot/core";
import { resolveCreatorNames } from "@/lib/dashboard-read";

export const alertSummarySelect = {
  id: true,
  name: true,
  view: true,
  measure: true,
  aggregation: true,
  window: true,
  thresholdOperator: true,
  threshold: true,
  status: true,
  severity: true,
  severityChangedAt: true,
  alertedAt: true,
  lastEvaluatedAt: true,
  lastError: true,
  lastErrorAt: true,
  lastNotifyStatus: true,
  lastNotifyError: true,
  lastNotifyAt: true,
  createTime: true,
  updateTime: true,
  createdBy: true,
} satisfies Prisma.AlertSelect;

export const alertSelect = {
  ...alertSummarySelect,
  filters: true,
  renotify: true,
  noDataMode: true,
} satisfies Prisma.AlertSelect;

export type AlertSummaryRow = Prisma.AlertGetPayload<{ select: typeof alertSummarySelect }>;
export type AlertRow = Prisma.AlertGetPayload<{ select: typeof alertSelect }>;

export interface AlertSummary {
  id: string;
  name: string;
  view: string;
  measure: string;
  aggregation: string;
  window: string;
  thresholdOperator: string;
  threshold: number;
  status: string;
  severity: string;
  severityChangedAt: Date | null;
  alertedAt: Date | null;
  lastEvaluatedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastNotifyStatus: string | null;
  lastNotifyError: string | null;
  lastNotifyAt: Date | null;
  createTime: Date;
  updateTime: Date;
  creator: string | null;
}

export interface AlertRecord extends AlertSummary {
  filters: AlertFilter[];
  renotify: AlertRenotify;
  noDataMode: string;
}

/**
 * `threshold` is `Decimal(65,30)`, which JSON.stringify renders as an object
 * rather than a number, so every response path converts through here.
 */
export function decimalToNumber(value: Prisma.Decimal | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

function toSummary(row: AlertSummaryRow, creator: string | null): AlertSummary {
  const { createdBy: _createdBy, threshold, ...rest } = row;
  return { ...rest, threshold: decimalToNumber(threshold), creator };
}

/**
 * `createdBy` holds a bare user id with no relation on the model, so display
 * names resolve in one batch here. A deleted account resolves to null.
 */
export async function withCreators(
  rows: AlertSummaryRow[],
  projectId: string,
): Promise<AlertSummary[]> {
  const byId = await resolveCreatorNames(
    rows.map((row) => row.createdBy),
    projectId,
  );
  return rows.map((row) => toSummary(row, byId.get(row.createdBy) ?? null));
}

/** Pure: the full record from a row plus an already-resolved creator name. */
export function toAlertRecord(row: AlertRow, creator: string | null): AlertRecord {
  return {
    ...toSummary(row, creator),
    filters: row.filters as unknown as AlertFilter[],
    renotify: row.renotify as unknown as AlertRenotify,
    noDataMode: row.noDataMode,
  };
}

export async function serializeAlert(row: AlertRow, projectId: string): Promise<AlertRecord> {
  const byId = await resolveCreatorNames([row.createdBy], projectId);
  return toAlertRecord(row, byId.get(row.createdBy) ?? null);
}
