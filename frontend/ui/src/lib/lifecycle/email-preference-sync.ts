/**
 * Keeps the provider's product-email topic in line with the account, which
 * holds the person's latest choice (pause.ts, recordUnsubscribe). The account
 * decides; the provider follows.
 *
 * - The unsubscribe page sets the provider at once (syncEmailPreference), and
 *   goes round again if another choice was applied meanwhile.
 * - Every provider write is recorded before it is sent (emailProviderWriteAt),
 *   so a write whose request dies before it can check the account still leaves
 *   a trace. The scheduled run (syncPendingEmailPreferences) then confirms each
 *   changed preference once its latest write is older than SETTLE_AFTER_MS,
 *   far longer than a provider request may take (resend.ts), so any write still
 *   on its way has landed or failed: it sets the provider to the account's
 *   choice again and marks it settled if no other choice or write came along.
 * - Nobody has to try again by hand, and one person the provider keeps refusing
 *   does not hold up the others: the run takes the least recently written first.
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

/** How long after the latest provider write the scheduled run confirms it. */
export const SETTLE_AFTER_MS = 10 * 60 * 1000;

// Rounds of "set the provider, then check the account" on the unsubscribe page.
const ATTEMPTS = 3;

async function readChoice(userId: string) {
  return prisma.userOnboarding.findUnique({
    where: { userId },
    select: { unsubscribedAt: true, emailPreferenceAt: true, emailPreferenceVersion: true },
  });
}

/** Records, by the database's clock, that a provider write is about to start. */
async function startWrite(userId: string): Promise<Date | null> {
  const [row] = await prisma.$queryRaw<{ at: Date }[]>`
    UPDATE user_onboarding SET email_provider_write_at = clock_timestamp()
    WHERE user_id = ${userId}
    RETURNING email_provider_write_at AS at`;
  return row?.at ?? null;
}

/**
 * Sets the provider to the account's choice in force, going round again if
 * another choice is applied meanwhile. Answers that choice once the provider
 * was set to it with no newer choice since, or null (the scheduled run
 * finishes it). Repeating it is harmless.
 */
export async function syncEmailPreference(
  userId: string,
  email: string,
  setTopic: SetProviderTopic = setProviderTopic,
): Promise<{ subscribed: boolean } | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await readChoice(userId);
    if (!before?.emailPreferenceAt) return null;
    const subscribed = !before.unsubscribedAt;
    if (!(await startWrite(userId))) return null;
    if (!(await setTopic(email, subscribed ? "opt_in" : "opt_out"))) return null;
    const after = await readChoice(userId);
    if (after?.emailPreferenceVersion === before.emailPreferenceVersion) return { subscribed };
  }
  return null;
}

/**
 * Confirms one preference for the scheduled run: sets the provider to the
 * account's choice and marks it settled, unless another choice or provider
 * write started meanwhile (then a later run confirms it).
 */
async function settleEmailPreference(
  userId: string,
  email: string,
  setTopic: SetProviderTopic,
): Promise<boolean> {
  const before = await readChoice(userId);
  if (!before?.emailPreferenceAt) return false;
  const started = await startWrite(userId);
  if (!started) return false;
  if (!(await setTopic(email, before.unsubscribedAt ? "opt_out" : "opt_in"))) return false;
  const { count } = await prisma.userOnboarding.updateMany({
    where: {
      userId,
      emailPreferenceVersion: before.emailPreferenceVersion,
      emailProviderWriteAt: started,
    },
    data: { emailProviderSettledAt: started },
  });
  return count > 0;
}

/**
 * The scheduled run: confirms, a bounded batch at a time, each preference with
 * a choice or a provider write since it was last confirmed, once its latest
 * write is SETTLE_AFTER_MS old. Least recently written first, so a person the
 * provider keeps refusing goes to the back each time. Answers how many it
 * confirmed and how many it tried without confirming.
 */
export async function syncPendingEmailPreferences(
  options: { limit?: number; settleAfterMs?: number; setTopic?: SetProviderTopic } = {},
): Promise<{ synced: number; pending: number }> {
  const limit = options.limit ?? 50;
  const settleAfterMs = options.settleAfterMs ?? SETTLE_AFTER_MS;
  const rows = await prisma.$queryRaw<{ user_id: string; email: string }[]>`
    SELECT o.user_id, u.email
    FROM user_onboarding o JOIN users u ON u.id = o.user_id
    WHERE o.email_preference_at IS NOT NULL
      AND (o.email_provider_settled_at IS NULL
           OR o.email_provider_write_at > o.email_provider_settled_at)
      AND (o.email_provider_write_at IS NULL
           OR o.email_provider_write_at <= clock_timestamp() - ${settleAfterMs} * interval '1 millisecond')
    ORDER BY o.email_provider_write_at NULLS FIRST, o.user_id
    LIMIT ${limit}`;
  let synced = 0;
  for (const row of rows) {
    const ok = await settleEmailPreference(
      row.user_id,
      row.email,
      options.setTopic ?? setProviderTopic,
    ).catch(() => false);
    if (ok) synced += 1;
  }
  return { synced, pending: rows.length - synced };
}
