import type { AlertSeverity, AlertStatus, AlertWindow } from "@traceroot/core";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { createTranslator, type Translate } from "@/lib/i18n/translate";

// Every function here takes the visitor's `t` last. A caller without one (the assistant's
// cards, a unit test) gets English, the text these functions always returned.
const ENGLISH = createTranslator(DEFAULT_LOCALE);

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

const SEVERITY_DISPLAY: Record<AlertSeverity, { labelKey: MessageKey; tone: AlertTone }> = {
  OK: { labelKey: "alertsDisplay.labelOk", tone: "ok" },
  ALERT: { labelKey: "alertsDisplay.labelAlert", tone: "alert" },
  NO_DATA: { labelKey: "alertsDisplay.labelNoData", tone: "warning" },
  UNKNOWN: { labelKey: "alertsDisplay.labelNoData", tone: "warning" },
};

const NO_ENTITLEMENT = "no-entitlement";

const DELIVERY_REASON_KEYS: Record<string, MessageKey> = {
  "no-channel": "alertsDisplay.noChannel",
  "no-bot-token": "alertsDisplay.slackIncomplete",
  "bot-token-undecryptable": "alertsDisplay.slackIncomplete",
  "retries-exhausted": "alertsDisplay.retriesExhausted",
  "permanent-slack-error": "alertsDisplay.slackRejected",
};

function describeDeliveryReason(code: string | null | undefined, t: Translate): string {
  if (!code) return t("alertsDisplay.unsent");
  if (code.startsWith(NO_ENTITLEMENT)) return t("alertsDisplay.noEntitlement");
  const key = DELIVERY_REASON_KEYS[code];
  return key ? t(key) : t("alertsDisplay.unsentWithCode", { code });
}

const SLACK_FIX_CODES: readonly string[] = [
  "no-channel",
  "no-bot-token",
  "bot-token-undecryptable",
];

/** Where a reader can go to make the next delivery succeed, when anywhere. */
export function resolveAlertDeliveryFix(
  alert: AlertDisplayInput,
  t: Translate = ENGLISH,
): AlertDeliveryFix | undefined {
  const code = alert.lastNotifyError;
  if (!code || !alert.lastNotifyStatus || alert.lastNotifyStatus === DELIVERED) return undefined;
  if (code.startsWith(NO_ENTITLEMENT)) {
    return { settingsPage: "billing", label: t("alertsDisplay.fixPlans") };
  }
  return SLACK_FIX_CODES.includes(code)
    ? { settingsPage: "integrations", label: t("alertsDisplay.fixSlack") }
    : undefined;
}

/**
 * A page the delivery worker took back outlives the error that recorded it: the
 * next successful run clears `lastError` within the minute, and the user still
 * never heard about the breach.
 */
function describeUndelivered(alert: AlertDisplayInput, t: Translate): string | undefined {
  const status = alert.lastNotifyStatus;
  if (!status || status === DELIVERED) return undefined;

  const reason = describeDeliveryReason(alert.lastNotifyError, t);
  return status === COMPENSATED
    ? t("alertsDisplay.rolledBack", { reason })
    : t("alertsDisplay.notRolledBack", { reason });
}

function withDetail(
  state: AlertDisplayState,
  extra: string | undefined,
  t: Translate,
): AlertDisplayState {
  if (extra === undefined) return state;
  return {
    ...state,
    detail:
      state.detail === undefined
        ? extra
        : t("alertsDisplay.joined", { first: state.detail, second: extra }),
  };
}

/**
 * Stands in when a parked row carries no reason, so the badge is never mute.
 * The only place this detail states the fix itself: every real parking path
 * (claim.ts's UNEVALUABLE_RULE_ERROR, scheduler.ts's PARKED_RULE_SUFFIX)
 * already says what unparks the rule, so restating it there would repeat the
 * same sentence back to back in one popover.
 */
const PARKED_WITHOUT_REASON: MessageKey = "alertsDisplay.parkedNoReason";

/**
 * Parked, then paused, then failing, then never run, each outranking the
 * severity beneath it: a severity is a report about a run, and these four say
 * the run did not happen. Parked leads because it is the only one of them that
 * no amount of waiting resolves.
 */
export function resolveAlertDisplayState(
  alert: AlertDisplayInput,
  t: Translate = ENGLISH,
): AlertDisplayState {
  if (alert.status === "PARKED") {
    return {
      label: t("alertsDisplay.labelParked"),
      tone: "warning",
      isPaused: false,
      isStopped: true,
      // Not "it will retry": that is the sentence this status exists to stop
      // telling. The error already says what unparks the rule, so this adds
      // nothing to it beyond the "Stopped:" framing.
      detail: alert.lastError
        ? t("alertsDisplay.stopped", { error: alert.lastError })
        : t(PARKED_WITHOUT_REASON),
    };
  }

  if (alert.status === "PAUSED") {
    return {
      label: t("alertsDisplay.labelPaused"),
      tone: "neutral",
      isPaused: true,
      isStopped: true,
    };
  }

  const undelivered = describeUndelivered(alert, t);

  if (alert.lastError) {
    return withDetail(
      {
        label: t("alertsDisplay.labelFailing"),
        tone: "alert",
        isPaused: false,
        isStopped: false,
        detail: t("alertsDisplay.lastRunFailed", { error: alert.lastError }),
      },
      undelivered,
      t,
    );
  }

  // Strict: an omitted field means the caller is asking for a plain severity
  // badge, which is not the same as a rule that has never run.
  if (alert.lastEvaluatedAt === null) {
    return withDetail(
      {
        label: t("alertsDisplay.labelNoData"),
        tone: "warning",
        isPaused: false,
        isStopped: false,
        detail: t("alertsDisplay.notRunYet"),
      },
      undelivered,
      t,
    );
  }

  const severity = SEVERITY_DISPLAY[alert.severity] ?? SEVERITY_DISPLAY.UNKNOWN;
  return withDetail(
    { label: t(severity.labelKey), tone: severity.tone, isPaused: false, isStopped: false },
    undelivered,
    t,
  );
}

export function formatAlertWindow(window: AlertWindow | string, t: Translate = ENGLISH): string {
  return t("alertsList.windowLast", { window });
}
