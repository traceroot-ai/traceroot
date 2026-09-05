import type { AlertSeverity, AlertStatus, AlertWindow } from "@traceroot/core";

export type AlertTone = "ok" | "alert" | "warning" | "neutral";

export interface AlertDisplayState {
  label: string;
  tone: AlertTone;
  isPaused: boolean;
  /** Parked as well as paused: both mean no tick will run this rule as it stands. */
  isStopped: boolean;
  /** Why the badge reads what it does. Undefined when the label says it all. */
  detail?: string;
}

export interface AlertDeliveryFix {
  /** Workspace settings tab that can undo the delivery failure. */
  settingsPage: "integrations" | "billing";
  label: string;
}

export interface AlertDisplayInput {
  status: AlertStatus;
  severity: AlertSeverity;
  lastError?: string | null;
  lastEvaluatedAt?: string | Date | null;
  lastNotifyStatus?: string | null;
  lastNotifyError?: string | null;
}

const DELIVERED = "DELIVERED";
const COMPENSATED = "COMPENSATED";

const SEVERITY_DISPLAY: Record<AlertSeverity, { label: string; tone: AlertTone }> = {
  OK: { label: "OK", tone: "ok" },
  ALERT: { label: "Alert", tone: "alert" },
  NO_DATA: { label: "No Data", tone: "warning" },
  UNKNOWN: { label: "No Data", tone: "warning" },
};

const UNSENT = "The last notification could not be sent.";
const NO_ENTITLEMENT = "no-entitlement";

const DELIVERY_REASONS: Record<string, string> = {
  "no-channel":
    "No Slack channel is set for this workspace, so nothing was sent. Choose one in workspace settings.",
  "no-bot-token":
    "This workspace's Slack connection is incomplete. Reconnect Slack in workspace settings.",
  "bot-token-undecryptable":
    "This workspace's Slack connection is incomplete. Reconnect Slack in workspace settings.",
  "retries-exhausted":
    "Slack did not accept the message after several attempts. It will be sent again the next time this rule changes.",
  "permanent-slack-error":
    "Slack rejected the message. Check the channel still exists and the app is still in it.",
};

function describeDeliveryReason(code: string | null | undefined): string {
  if (!code) return UNSENT;
  if (code.startsWith(NO_ENTITLEMENT)) {
    return "Slack delivery is not included in this workspace's plan.";
  }
  return DELIVERY_REASONS[code] ?? `${UNSENT} (${code})`;
}

const SLACK_FIX: AlertDeliveryFix = { settingsPage: "integrations", label: "Open Slack settings" };

const DELIVERY_FIXES: Record<string, AlertDeliveryFix> = {
  "no-channel": SLACK_FIX,
  "no-bot-token": SLACK_FIX,
  "bot-token-undecryptable": SLACK_FIX,
};

/** Where a reader can go to make the next delivery succeed, when anywhere. */
export function resolveAlertDeliveryFix(alert: AlertDisplayInput): AlertDeliveryFix | undefined {
  const code = alert.lastNotifyError;
  if (!code || !alert.lastNotifyStatus || alert.lastNotifyStatus === DELIVERED) return undefined;
  if (code.startsWith(NO_ENTITLEMENT)) return { settingsPage: "billing", label: "See plans" };
  return DELIVERY_FIXES[code];
}

/**
 * A page the delivery worker took back outlives the error that recorded it: the
 * next successful run clears `lastError` within the minute, and the user still
 * never heard about the breach.
 */
function describeUndelivered(alert: AlertDisplayInput): string | undefined {
  const status = alert.lastNotifyStatus;
  if (!status || status === DELIVERED) return undefined;

  const reason = describeDeliveryReason(alert.lastNotifyError);
  return status === COMPENSATED
    ? `${reason} The alert was rolled back, so the next breach raises it again.`
    : `${reason} The alert it belonged to could not be rolled back.`;
}

function withDetail(state: AlertDisplayState, extra: string | undefined): AlertDisplayState {
  if (extra === undefined) return state;
  return { ...state, detail: state.detail === undefined ? extra : `${state.detail} ${extra}` };
}

/** Stands in when a parked row carries no reason, so the badge is never mute. */
const PARKED_WITHOUT_REASON = "Stopped: this rule's settings cannot be evaluated.";

/**
 * Parked, then paused, then failing, then never run, each outranking the
 * severity beneath it: a severity is a report about a run, and these four say
 * the run did not happen. Parked leads because it is the only one of them that
 * no amount of waiting resolves.
 */
export function resolveAlertDisplayState(alert: AlertDisplayInput): AlertDisplayState {
  if (alert.status === "PARKED") {
    return {
      label: "Parked",
      tone: "warning",
      isPaused: false,
      isStopped: true,
      // Not "it will retry": that is the sentence this status exists to stop
      // telling. The error already carries what the evaluator refused.
      detail: `${alert.lastError ? `Stopped: ${alert.lastError}.` : PARKED_WITHOUT_REASON} Edit and save the rule to start it again.`,
    };
  }

  if (alert.status === "PAUSED") {
    return { label: "Paused", tone: "neutral", isPaused: true, isStopped: true };
  }

  const undelivered = describeUndelivered(alert);

  if (alert.lastError) {
    return withDetail(
      {
        label: "Failing",
        tone: "alert",
        isPaused: false,
        isStopped: false,
        detail: `Last run failed: ${alert.lastError}. It will retry next minute; if this persists, check the rule's filters and measure.`,
      },
      undelivered,
    );
  }

  // Strict: an omitted field means the caller is asking for a plain severity
  // badge, which is not the same as a rule that has never run.
  if (alert.lastEvaluatedAt === null) {
    return withDetail(
      {
        label: "No Data",
        tone: "warning",
        isPaused: false,
        isStopped: false,
        detail: "This rule has not run yet. Its first result appears within a minute.",
      },
      undelivered,
    );
  }

  const severity = SEVERITY_DISPLAY[alert.severity] ?? SEVERITY_DISPLAY.UNKNOWN;
  return withDetail({ ...severity, isPaused: false, isStopped: false }, undelivered);
}

export function formatAlertWindow(window: AlertWindow | string): string {
  return `Last ${window}`;
}
