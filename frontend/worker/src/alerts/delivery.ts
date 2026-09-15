import type { AlertSeverity } from "@traceroot/core";
import type { AlertRule } from "./rule.js";

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

const FAILED = "FAILED";

/**
 * Whether the page this rule is standing on never reached anyone for want of Slack,
 * and Slack has been set up since. A breach that fires before Slack is connected is
 * otherwise never announced: the state machine only speaks on a transition, and the
 * failure is recorded without a rollback, so nothing is left to transition.
 *
 * Loop-free by construction: the retry records its own outcome after the settings
 * change it answered, so it is one retry per change, never one per tick into the
 * same wall.
 *
 * - the failure is about the emission still standing: recorded after it was stamped,
 *   the rule has held that emission's severity since, and this evaluation read it again;
 * - Slack's settings moved after that failure was recorded.
 */
export function isAwaitingSlackRetry(rule: AlertRule, severity: AlertSeverity): boolean {
  const { state, lastDelivery } = rule;
  if (lastDelivery.status !== FAILED) return false;
  if (lastDelivery.error === null || !SLACK_CONFIGURATION_FAILURES.has(lastDelivery.error)) {
    return false;
  }
  if (state.alertedAt === null || lastDelivery.at === null) return false;
  if (severity !== state.severity) return false;
  // `alertedAt` outlives a silent move into NO_DATA, so a severity entered after the
  // page is not the one that page announced: replaying it would page the wrong thing.
  const { severityChangedAt } = state;
  if (severityChangedAt !== null && severityChangedAt.getTime() > state.alertedAt.getTime()) {
    return false;
  }
  if (lastDelivery.at.getTime() < state.alertedAt.getTime()) return false;
  const { slackUpdatedAt } = lastDelivery;
  return slackUpdatedAt !== null && slackUpdatedAt.getTime() > lastDelivery.at.getTime();
}
