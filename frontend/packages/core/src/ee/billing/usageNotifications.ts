// Free-plan usage-quota notification decision. Pure — no clock, no DB —
// so the same helper drives every meter and is trivially unit-testable.

export type UsageMeter = "events" | "rca" | "detector";

// Warn when usage reaches this fraction of the free-plan cap.
export const USAGE_WARNING_RATIO = 0.8;

export interface UsageNotificationState {
  warningSentAt: Date | null;
  blockedSentAt: Date | null;
}

export interface UsageNotificationDecision {
  send: "none" | "warning" | "blocked";
  stampWarning: boolean;
  stampBlocked: boolean;
}

/**
 * Decide which usage-quota email (if any) to send for one meter, given the
 * current usage, the plan cap, and what was already sent this usage window
 * (state = null means nothing sent / new window).
 *
 * Stamps accompany sends: the caller records a stamp ONLY after the email
 * actually went out, so a failed send retries on the next run. When 80% and
 * 100% are first crossed in the same tick, only the blocked email is sent
 * but both thresholds are stamped so the obsolete warning never fires later.
 */
export function decideUsageNotification(args: {
  used: number;
  cap: number;
  state: UsageNotificationState | null;
}): UsageNotificationDecision {
  const { used, cap, state } = args;
  const none: UsageNotificationDecision = {
    send: "none",
    stampWarning: false,
    stampBlocked: false,
  };
  if (!Number.isFinite(cap) || cap <= 0) return none;

  const warningSent = state?.warningSentAt != null;
  const blockedSent = state?.blockedSentAt != null;

  if (used >= cap) {
    if (blockedSent) return none;
    return { send: "blocked", stampWarning: !warningSent, stampBlocked: true };
  }
  if (used >= cap * USAGE_WARNING_RATIO && !warningSent) {
    return { send: "warning", stampWarning: true, stampBlocked: false };
  }
  return none;
}
