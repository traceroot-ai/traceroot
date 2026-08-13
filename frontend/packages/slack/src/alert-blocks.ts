// Block Kit for one alert-rule notification. Pure: payload in, message out, no I/O.

import {
  ALERT_THRESHOLD_OPERATOR_PHRASES,
  type AlertSeverity,
  type AlertThresholdOperator,
} from "@traceroot/core";
import { escapeMrkdwn, formatWindowRange, truncate } from "./block-kit.ts";

const HEADER_LIMIT = 150;

/** Grey for the two severities that assert nothing about the data. */
export const ALERT_SEVERITY_COLORS: Record<AlertSeverity, string> = {
  ALERT: "#c0362c",
  OK: "#1a7f4e",
  NO_DATA: "#8a8f98",
  UNKNOWN: "#8a8f98",
};

// Only latency's raw value is meaningless without a unit; other measures name theirs.
const MEASURE_UNIT_SUFFIX: Record<string, string> = {
  latency: "ms",
};

export interface AlertBlockParams {
  appBaseUrl: string;
  projectId: string;
  alertId: string;
  /** User-controlled; escaped at render. */
  name: string;
  severity: AlertSeverity;
  previousSeverity: AlertSeverity;
  /** Null when the window produced no value (NO_DATA). */
  value: number | null;
  threshold: number;
  thresholdOperator: AlertThresholdOperator;
  measure: string;
  aggregation: string;
  window: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface AlertSlackMessage {
  blocks: unknown[];
  /** Attachment colour; the caller nests `blocks` in an attachment carrying it. */
  color: string;
  /** Notification fallback for clients that render no blocks. */
  text: string;
}

export function alertUrl(appBaseUrl: string, projectId: string, alertId: string): string {
  return (
    `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/alerts/` +
    `${encodeURIComponent(alertId)}`
  );
}

/** `date_filter=custom` is REQUIRED: the list pages only hydrate a custom start/end with it. */
export function alertSpansUrl(
  appBaseUrl: string,
  projectId: string,
  windowStart: Date,
  windowEnd: Date,
): string {
  const range =
    `date_filter=custom` +
    `&start=${encodeURIComponent(windowStart.toISOString())}` +
    `&end=${encodeURIComponent(windowEnd.toISOString())}`;
  return `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/traces?${range}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

function formatMeasureValue(measure: string, value: number): string {
  return `${formatNumber(value)}${MEASURE_UNIT_SUFFIX[measure] ?? ""}`;
}

// Call form reads as the aggregation applied to the measure. The row-count
// pseudo-measure pins its aggregation to itself, which would say count twice.
function measureLabel(aggregation: string, measure: string): string {
  return `\`${aggregation === measure ? measure : `${aggregation}(${measure})`}\``;
}

function describeOutcome(params: AlertBlockParams): string {
  const { severity, value, threshold, thresholdOperator, measure, aggregation, window } = params;
  const label = measureLabel(aggregation, measure);
  const thresholdText = formatMeasureValue(measure, threshold);

  if (severity === "NO_DATA" || value === null) {
    return `No data for ${label} over the last ${window}, so the ${thresholdText} threshold could not be evaluated.`;
  }

  const valueText = formatMeasureValue(measure, value);
  if (severity === "OK") {
    return `${label} recovered to ${valueText}, back within the ${thresholdText} threshold, over the last ${window}.`;
  }
  return `${label} was ${valueText}, ${ALERT_THRESHOLD_OPERATOR_PHRASES[thresholdOperator]} the ${thresholdText} threshold, over the last ${window}.`;
}

export function buildAlertBlocks(params: AlertBlockParams): AlertSlackMessage {
  const { appBaseUrl, projectId, alertId, name, severity, previousSeverity } = params;
  const { windowStart, windowEnd } = params;

  const title = `[${severity}] ${name}`;
  const outcome = describeOutcome(params);

  const links = [`<${alertUrl(appBaseUrl, projectId, alertId)}|View alert>`];
  // A recovery is within threshold and NO_DATA is empty: a spans link lands on nothing.
  if (severity === "ALERT") {
    links.push(`<${alertSpansUrl(appBaseUrl, projectId, windowStart, windowEnd)}|View spans>`);
  }

  const footer = `${formatWindowRange(windowStart, windowEnd)} · ${previousSeverity} to ${severity}`;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: truncate(title, HEADER_LIMIT) } },
    { type: "section", text: { type: "mrkdwn", text: truncate(escapeMrkdwn(outcome)) } },
    { type: "section", text: { type: "mrkdwn", text: truncate(links.join(" · ")) } },
    { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
  ];

  return {
    blocks,
    color: ALERT_SEVERITY_COLORS[severity],
    // Slack parses the fallback text as mrkdwn, so it needs escaping too:
    // unescaped, an alert named "<!channel>" would broadcast.
    text: truncate(escapeMrkdwn(`${title} — ${outcome}`), HEADER_LIMIT * 2),
  };
}
