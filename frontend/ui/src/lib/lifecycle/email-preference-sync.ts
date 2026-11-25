/**
 * Keeps the provider's product-email topic in line with the account, which
 * holds the person's own choices (pause.ts, recordUnsubscribe), while keeping
 * an opt-out the person makes at the provider itself.
 *
 * - The unsubscribe page sets the provider at once (syncEmailPreference). A
 *   write that succeeds with no other choice applied meanwhile is acknowledged
 *   (emailProviderAckVersion). A request that finds its write was of an older
 *   choice clears the acknowledgement before correcting it, since that stale
 *   write is now at the provider.
 * - Every provider write is recorded before it is sent (emailProviderWriteAt).
 *   The scheduled run (syncPendingEmailPreferences) looks at each changed
 *   preference once its latest write is older than SETTLE_AFTER_MS, far longer
 *   than a provider request may take (resend.ts), so writes still on their way
 *   have landed. It reads the provider first:
 *   - it already holds the account's choice: confirmed;
 *   - the account's choice was never acknowledged (its write failed, is
 *     pending, or a stale write may have replaced it): the account's choice is
 *     the newer one, and is set at the provider;
 *   - the account's choice was acknowledged and the provider has changed since:
 *     the person (or something else) changed it there, and which came last
 *     cannot be known, so the opt-out wins: an opt-out at the provider is
 *     recorded on the account, or the provider is set back to opt-out.
 * - Nobody has to try again by hand, and one person the provider keeps refusing
 *   does not hold up the others: the run takes the least recently looked at first.
 */
import { prisma } from "@traceroot/core";
import {
  ensureContact,
  providerState,
  resendConfig,
  setTopicSubscription,
  type TopicSubscription,
} from "@traceroot/core/email";

/** Sets the provider's topic for one address; false on any failure. */
export type SetProviderTopic = (email: string, choice: TopicSubscription) => Promise<boolean>;
/** Reads the provider's topic for one address; null when it cannot be read. */
export type ReadProviderTopic = (email: string) => Promise<TopicSubscription | "missing" | null>;

export const setProviderTopic: SetProviderTopic = async (email, choice) => {
  try {
    const contact = await ensureContact({ email });
    return contact.ok && (await setTopicSubscription(email, choice)).ok;
  } catch {
    return false;
  }
};

export const readProviderTopic: ReadProviderTopic = async (email) => {
  const config = resendConfig();
  if (!config.apiKey) return null;
  try {
    const state = await providerState(email, {
      apiKey: config.apiKey,
      productTopicId: config.productTopicId,
      fetchImpl: fetch,
    });
    if (state === "subscribed") return "opt_in";
    if (state === "unsubscribed") return "opt_out";
    return state === "no_contact" ? "missing" : null;
  } catch {
    return null;
  }
};

/** How long after the latest provider write the scheduled run looks at it. */
export const SETTLE_AFTER_MS = 10 * 60 * 1000;
/** Per scheduled tick: at most this many people, and no new one after this long. */
export const PER_TICK = 20;
export const TICK_BUDGET_MS = 15_000;

// Rounds of "set the provider, then check the account" on the unsubscribe page.
const ATTEMPTS = 3;

async function readChoice(userId: string) {
  return prisma.userOnboarding.findUnique({
    where: { userId },
    select: {
      unsubscribedAt: true,
      emailPreferenceAt: true,
      emailPreferenceVersion: true,
      emailProviderWriteAt: true,
      emailProviderAckVersion: true,
    },
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

/** The provider holds this version, if no other choice was applied meanwhile. */
async function acknowledge(userId: string, version: number): Promise<boolean> {
  const { count } = await prisma.userOnboarding.updateMany({
    where: { userId, emailPreferenceVersion: version },
    data: { emailProviderAckVersion: version },
  });
  return count > 0;
}

/**
 * Sets the provider to the account's choice in force, going round again if
 * another choice is applied meanwhile. Answers that choice once the provider
 * acknowledged it, or null (the scheduled run finishes it). Repeating it is
 * harmless.
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
    if (await acknowledge(userId, before.emailPreferenceVersion)) return { subscribed };
    // A newer choice was applied while this one was on its way: what the
    // provider now holds may be this older one, so nothing stays acknowledged.
    await prisma.userOnboarding.updateMany({
      where: { userId },
      data: { emailProviderAckVersion: null },
    });
  }
  return null;
}

type Settle = { setTopic: SetProviderTopic; readTopic: ReadProviderTopic };

/**
 * Looks at one preference for the scheduled run (see the top of this file).
 * Marks it settled only if no other choice or write came along meanwhile;
 * otherwise a later run looks again.
 */
async function settleEmailPreference(userId: string, email: string, io: Settle): Promise<boolean> {
  // Looked at now, whatever comes of it: a person whose provider cannot be read
  // goes behind the others next time, and stays pending.
  await prisma.userOnboarding.updateMany({
    where: { userId },
    data: { emailProviderCheckedAt: new Date() },
  });
  const before = await readChoice(userId);
  if (!before?.emailPreferenceAt) return false;
  const version = before.emailPreferenceVersion;
  const want: TopicSubscription = before.unsubscribedAt ? "opt_out" : "opt_in";
  const held = await io.readTopic(email);
  if (!held) return false;

  const settle = (writeAt: Date | null, ackVersion: number) =>
    prisma.userOnboarding
      .updateMany({
        where: { userId, emailPreferenceVersion: version, emailProviderWriteAt: writeAt },
        data: {
          emailProviderSettledAt: writeAt ?? new Date(0),
          emailProviderAckVersion: ackVersion,
        },
      })
      .then(({ count }) => count > 0);

  if (held === want) return settle(before.emailProviderWriteAt, version);

  const acknowledged = before.emailProviderAckVersion === version;
  if (acknowledged && held === "opt_out") {
    // The provider changed after it held the account's Subscribe again: keep
    // the opt-out, on the account too. Guarded by the version, so a choice made
    // meanwhile is not overwritten.
    const recorded = await prisma.$executeRaw`
      UPDATE user_onboarding
      SET unsubscribed_at = COALESCE(unsubscribed_at, clock_timestamp()::timestamp(3)),
          email_preference_version = email_preference_version + 1,
          email_provider_ack_version = email_preference_version + 1,
          email_provider_settled_at = COALESCE(email_provider_write_at, 'epoch'::timestamp)
      WHERE user_id = ${userId} AND email_preference_version = ${version}`;
    return recorded > 0;
  }
  // Not acknowledged: the account's choice is newer than what the provider
  // holds. Acknowledged with the provider at opt-in (or no contact) while the
  // account says opt-out: the opt-out wins. Either way the account's choice.
  const started = await startWrite(userId);
  if (!started) return false;
  if (!(await io.setTopic(email, want))) return false;
  return settle(started, version);
}

/**
 * The scheduled run: looks, a bounded batch at a time, at each preference with
 * a choice or a provider write since it was last confirmed, once its latest
 * write is SETTLE_AFTER_MS old. Least recently looked at first, so a person the
 * provider keeps refusing, or whose state it cannot give, goes to the back each
 * time and is tried again later. Stops starting new
 * people after budgetMs, so a slow provider leaves time for the tick's other
 * jobs; the rest wait for the next run. Answers how many it confirmed, how many
 * it tried without confirming, and how many it left for the next run.
 */
export async function syncPendingEmailPreferences(
  options: {
    limit?: number;
    budgetMs?: number;
    settleAfterMs?: number;
    setTopic?: SetProviderTopic;
    readTopic?: ReadProviderTopic;
  } = {},
): Promise<{ synced: number; pending: number; remaining: number }> {
  const limit = options.limit ?? PER_TICK;
  const budgetMs = options.budgetMs ?? TICK_BUDGET_MS;
  const settleAfterMs = options.settleAfterMs ?? SETTLE_AFTER_MS;
  const io = {
    setTopic: options.setTopic ?? setProviderTopic,
    readTopic: options.readTopic ?? readProviderTopic,
  };
  const rows = await prisma.$queryRaw<{ user_id: string; email: string }[]>`
    SELECT o.user_id, u.email
    FROM user_onboarding o JOIN users u ON u.id = o.user_id
    WHERE o.email_preference_at IS NOT NULL
      AND (o.email_provider_settled_at IS NULL
           OR o.email_provider_write_at > o.email_provider_settled_at)
      AND (o.email_provider_write_at IS NULL
           OR o.email_provider_write_at <= clock_timestamp() - ${settleAfterMs} * interval '1 millisecond')
    ORDER BY o.email_provider_checked_at NULLS FIRST, o.email_provider_write_at, o.user_id
    LIMIT ${limit}`;
  const started = Date.now();
  let synced = 0;
  let tried = 0;
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break;
    tried += 1;
    const ok = await settleEmailPreference(row.user_id, row.email, io).catch(() => false);
    if (ok) synced += 1;
  }
  return { synced, pending: tried - synced, remaining: rows.length - tried };
}
