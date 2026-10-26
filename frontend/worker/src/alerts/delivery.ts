import type { AlertSeverity } from "@traceroot/core";
import type { AlertLastDelivery, AlertRule } from "./rule.js";

/**
 * Non-deliveries only the workspace's Slack settings can clear. Recorded rather than
 * rolled back (see `alert-slack.ts`), which is what leaves them standing on the row
 * for a later tick to notice that the settings have since changed.
 */
export const SLACK_CONFIGURATION_FAILURES: ReadonlySet<string> = new Set([
  "no-channel",
  "no-bot-token",
  "bot-token-undecryptable",
]);

/** The delivery worker giving up once transient failures outlast a job's attempts. */
export const RETRIES_EXHAUSTED = "retries-exhausted";

const FAILED = "FAILED";
const COMPENSATED = "COMPENSATED";

/**
 * The two non-deliveries a later tick has to resend itself:
 *
 * - FAILED for want of Slack, once Slack's settings have moved since. One retry per
 *   change: a failure no setting has answered would only run into the same wall.
 * - COMPENSATED after transient failures outlasted a delivery cycle. Its rollback
 *   restores the state before the emission, and when the rule still holds that
 *   severity there is no transition left to re-emit, so this restarts the cycle the
 *   way ordinary compensation does. Only this reason: every other compensation is
 *   about the rule or project, not the send.
 */
function isRedeliverable(lastDelivery: AlertLastDelivery): boolean {
  const { status, error, at, slackUpdatedAt } = lastDelivery;
  if (error === null || at === null) return false;
  if (status === COMPENSATED) return error === RETRIES_EXHAUSTED;
  if (status !== FAILED || !SLACK_CONFIGURATION_FAILURES.has(error)) return false;
  return slackUpdatedAt !== null && slackUpdatedAt.getTime() > at.getTime();
}

/**
 * Whether the page this rule is standing on never reached anyone and is due again.
 * The state machine only speaks on a transition, so without this a breach whose page
 * was lost stays silent until its severity changes.
 *
 * The page must still be the one standing: recorded at or after the stamp it left,
 * and announcing the severity this evaluation just read. That severity is the
 * attempt's own, never the rule's: a rule moves without paging (into NO_DATA under
 * HOLD, and back), so its severity says nothing about what the page said. An attempt
 * recorded before the attempt's severity was kept is never replayed.
 */
export function isAwaitingRedelivery(rule: AlertRule, severity: AlertSeverity): boolean {
  const { state, lastDelivery } = rule;
  if (!isRedeliverable(lastDelivery)) return false;
  if (lastDelivery.severity === null || lastDelivery.severity !== severity) return false;
  if (state.alertedAt === null || lastDelivery.at === null) return false;
  return lastDelivery.at.getTime() >= state.alertedAt.getTime();
}
