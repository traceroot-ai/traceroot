// Role — re-exported from Prisma (runtime object + type)
export { MemberRole as Role } from "@prisma/client";

// SpanKind — ClickHouse values
export const SpanKind = {
  LLM: "LLM",
  AGENT: "AGENT",
  TOOL: "TOOL",
  SPAN: "SPAN",
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

// SpanStatus — ClickHouse values
export const SpanStatus = { OK: "OK", ERROR: "ERROR" } as const;
export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];

// Alert aggregation windows — the single source of truth.
// Keys are the stored/validated tokens; values are their canonical millisecond
// durations. The API allowlist, the worker's window->ms lookup, and the UI
// dropdown all derive from this one map, so a window is added/changed here once.
// Every detector alert is a windowed digest; 1m is the most frequent option.
export const ALERT_WINDOWS = {
  "1m": 60_000,
  "5m": 300_000,
  "10m": 600_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
} as const;
export type AlertWindow = keyof typeof ALERT_WINDOWS;

// Default window for projects without an explicit choice (and the Prisma
// column default — keep `@default("10m")` on DetectorAlertConfig.alertWindow in
// sync with this token).
export const DEFAULT_ALERT_WINDOW: AlertWindow = "10m";

export function isAlertWindow(value: string): value is AlertWindow {
  return Object.prototype.hasOwnProperty.call(ALERT_WINDOWS, value);
}
