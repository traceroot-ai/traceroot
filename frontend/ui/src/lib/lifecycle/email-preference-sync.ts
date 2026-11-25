/**
 * Keeps the provider's product-email topic in line with the account, which
 * holds the person's latest choice (pause.ts, recordUnsubscribe). The account
 * decides; the provider follows. A choice is synced once the provider was set
 * to it and the account still held that same choice afterwards; then
 * emailPreferenceSyncedAt catches up with emailPreferenceAt. A sync that does
 * not finish (a provider error, a crash, a newer choice arriving meanwhile) is
 * finished by the scheduled run, so nobody has to try again by hand.
 */
import { prisma } from "@traceroot/core";
import { ensureContact, setTopicSubscription, type TopicSubscription } from "@traceroot/core/email";

/** Sets the provider's topic for one address; false on any failure. */
export type SetProviderTopic = (email: string, choice: TopicSubscription) => Promise<boolean>;

export const setProviderTopic: SetProviderTopic = async (email, choice) => {
  try {
    const contact = await ensureContact({ email });
    return contact.ok && (await setTopicSubscription(email, choice)).ok;
  } catch {
    return false;
  }
};

// Rounds of "set the provider, then check the account" before leaving the rest
// to the scheduled run.
const ATTEMPTS = 3;

/**
 * Brings the provider in line with the account's choice in force. Answers that
 * choice once the provider holds it, or null when it could not confirm (left to
 * the scheduled run). Repeating it is harmless.
 */
export async function syncEmailPreference(
  userId: string,
  email: string,
  setTopic: SetProviderTopic = setProviderTopic,
): Promise<{ subscribed: boolean } | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await prisma.userOnboarding.findUnique({
      where: { userId },
      select: { unsubscribedAt: true, emailPreferenceAt: true },
    });
    if (!before?.emailPreferenceAt) return null;
    const subscribed = !before.unsubscribedAt;
    if (!(await setTopic(email, subscribed ? "opt_in" : "opt_out"))) return null;
    // Synced only if no other choice landed while the provider was being set;
    // otherwise go round again and set it to that one. The state is compared as
    // well as the time: an unsubscribe made in the same millisecond as the
    // choice read here keeps that time but changes the state.
    const { count } = await prisma.userOnboarding.updateMany({
      where: {
        userId,
        emailPreferenceAt: before.emailPreferenceAt,
        unsubscribedAt: before.unsubscribedAt,
      },
      data: { emailPreferenceSyncedAt: before.emailPreferenceAt },
    });
    if (count > 0) return { subscribed };
  }
  return null;
}

/**
 * The scheduled run: finishes the syncs that did not complete, oldest first, a
 * bounded batch per run. Answers how many it synced and how many it left for
 * the next run.
 */
export async function syncPendingEmailPreferences(
  options: { limit?: number; setTopic?: SetProviderTopic } = {},
): Promise<{ synced: number; pending: number }> {
  const limit = options.limit ?? 50;
  const rows = await prisma.$queryRaw<{ user_id: string; email: string }[]>`
    SELECT o.user_id, u.email
    FROM user_onboarding o JOIN users u ON u.id = o.user_id
    WHERE o.email_preference_at IS NOT NULL
      AND (o.email_preference_synced_at IS NULL
           OR o.email_preference_synced_at < o.email_preference_at)
    ORDER BY o.email_preference_at
    LIMIT ${limit}`;
  let synced = 0;
  for (const row of rows) {
    if (await syncEmailPreference(row.user_id, row.email, options.setTopic)) synced += 1;
  }
  return { synced, pending: rows.length - synced };
}
