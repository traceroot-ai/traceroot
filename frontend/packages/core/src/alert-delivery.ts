// Slack delivery-reason vocabulary shared by the delivery worker and the
// alerts UI badge. A leaf module by design: no imports, so the client bundle
// (via the `@traceroot/core/alert-delivery` subpath) never evaluates the
// `@prisma/client` chain that `alerts.ts` pulls in through `./constants.ts`.
// Server consumers read the same values through the barrel re-export in
// `alerts.ts`. Keep the three lists as the single source of truth — the
// worker's redelivery predicate and the badge's follow-up sentences must agree
// on which reasons redeliver, or the badge promises what the worker will not do.

/**
 * Non-deliveries only the workspace's Slack settings can clear. The worker
 * records these rather than rolling them back, which is what leaves them
 * standing on the row for a later tick to notice that the settings have since
 * changed — and what lets the badge promise a redelivery for them.
 */
export const SLACK_CONFIGURATION_FAILURES: ReadonlySet<string> = new Set([
  "no-channel",
  "no-bot-token",
  "bot-token-undecryptable",
]);

/** The delivery worker giving up once transient failures outlast a job's attempts. */
export const RETRIES_EXHAUSTED = "retries-exhausted";

/**
 * Slack refused the message for good (deleted channel, removed app): retrying
 * changes nothing, so the worker records it rather than rolling it back, and
 * the notification is never resent.
 */
export const PERMANENT_SLACK_ERROR = "permanent-slack-error";
