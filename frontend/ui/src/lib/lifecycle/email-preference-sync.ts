/**
 * Keeps the provider's product-email topic in line with the account, which
 * holds the person's own choices (pause.ts, recordUnsubscribe), while keeping
 * an opt-out the person makes at the provider itself. The provider gives no
 * times, so the order of what reaches it is kept here:
 *
 * - One write per person at a time. A writer takes a lease
 *   (emailProviderLeaseUntil) with a short conditional update before sending,
 *   and gives it back when the answer comes; no database connection is held
 *   while it waits. Everything a writer asks the provider under the lease (the
 *   scheduled run's reads, the contact lookup and create, the write) shares one
 *   budget, HOLD_BUDGET_MS from taking it, well inside LEASE_MS: no request
 *   starts after it, a write starts only while the lease is held for the rest
 *   of it, and a writer whose lease ran out before its answer came
 *   acknowledges nothing. So a write never lands after one that started later.
 * - A choice made while another write holds the lease is not sent alongside
 *   it: it is marked as racing that write (emailProviderContendedVersion), and
 *   when the write in flight comes back the writer sends a newer opt-out at
 *   once (an opt-out is always safe to send) and leaves a newer opt-in for the
 *   scheduled run.
 * - A write that comes back with its own choice still in force is
 *   acknowledged (emailProviderAckVersion).
 * - The scheduled run (syncPendingEmailPreferences) looks at each changed
 *   preference once its latest write is older than SETTLE_AFTER_MS, takes the
 *   lease and reads the provider first:
 *   - it already holds the account's choice: confirmed;
 *   - the choice raced a write, or was acknowledged and the provider changed
 *     since: which came last cannot be known, so the opt-out wins (an opt-out
 *     at the provider is recorded on the account; an opt-in there under an
 *     account opt-out is set back);
 *   - the choice was written with no answer (its writer died, or none came):
 *     likewise unknown, so the opt-out wins;
 *   - otherwise its write was refused (an error answer) or never sent: the
 *     account's choice is set at the provider, so a refused request recovers
 *     with no action by the person.
 * - The run takes the least recently looked at first and is bounded per tick,
 *   so nobody holds up the others.
 */
import { prisma } from "@traceroot/core";
import {
  ensureContact,
  providerState,
  resendConfig,
  setTopicSubscription,
  type TopicSubscription,
} from "@traceroot/core/email";

/**
 * Sets the provider's topic for one address. "rejected": not applied for
 * certain (an error answer, or nothing sent); "unknown": it may or may not have
 * been applied (no answer).
 */
export type WriteOutcome = "ok" | "rejected" | "unknown";
export type SetProviderTopic = (
  email: string,
  choice: TopicSubscription,
  /** Ends every provider request of this write; an ended one counts as no answer. */
  deadline?: AbortSignal,
) => Promise<WriteOutcome>;
/** Reads the provider's topic for one address; null when it cannot be read. */
export type ReadProviderTopic = (
  email: string,
  /** Ends every provider request of the read (all its pages). */
  deadline?: AbortSignal,
) => Promise<TopicSubscription | "missing" | null>;

/** A fetch whose every request also ends at `deadline`. */
function fetchUntil(deadline?: AbortSignal): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: deadline
        ? init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline
        : init?.signal,
    });
}

export const setProviderTopic: SetProviderTopic = async (email, choice, deadline) => {
  const fetchImpl = fetchUntil(deadline);
  try {
    // No contact, no topic write: nothing was applied.
    if (!(await ensureContact({ email }, { fetchImpl })).ok) return "rejected";
    // Out of time before the write: it is not sent.
    if (deadline?.aborted) return "rejected";
    const result = await setTopicSubscription(email, choice, { fetchImpl });
    if (result.ok) return "ok";
    return result.rejected ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
};

export const readProviderTopic: ReadProviderTopic = async (email, deadline) => {
  const config = resendConfig();
  if (!config.apiKey) return null;
  try {
    const state = await providerState(email, {
      apiKey: config.apiKey,
      productTopicId: config.productTopicId,
      fetchImpl: fetchUntil(deadline),
    });
    if (state === "subscribed") return "opt_in";
    if (state === "unsubscribed") return "opt_out";
    return state === "no_contact" ? "missing" : null;
  } catch {
    return null;
  }
};

// Wherever the database writes or compares a time here, it reads its clock as
// UTC wall time (clock_timestamp() AT TIME ZONE 'UTC'): the columns hold UTC
// wall time, as the application's own writes store it, whatever the session's
// time zone.

/** How long after the latest provider write the scheduled run looks at it. */
export const SETTLE_AFTER_MS = 10 * 60 * 1000;
/** How long a writer holds the lease. */
export const LEASE_MS = 60_000;
/**
 * One budget for everything a writer asks the provider while it holds the
 * lease, counted from when it took it: the scheduled run's reads (every page),
 * the contact lookup and create, and the write. Well inside the lease, so no
 * request starts, and none is still waited on, once anyone else could take it.
 */
export const HOLD_BUDGET_MS = 30_000;

/** The lease and budget lengths; shorter ones only in tests. */
export type Timing = { leaseMs: number; holdBudgetMs: number };
const DEFAULT_TIMING: Timing = { leaseMs: LEASE_MS, holdBudgetMs: HOLD_BUDGET_MS };

/** A lease this writer holds: its token, and the budget counted from taking it. */
type Hold = { lease: Date; deadline: AbortSignal; endsAt: number };
/** Per scheduled tick: at most this many people, and no new one after this long. */
export const PER_TICK = 20;
export const TICK_BUDGET_MS = 15_000;

type Choice = {
  unsubscribedAt: Date | null;
  emailPreferenceAt: Date | null;
  emailPreferenceVersion: number;
  emailProviderWriteAt: Date | null;
  emailProviderAckVersion: number | null;
  emailProviderContendedVersion: number | null;
  emailProviderWriteVersion: number | null;
  emailProviderRejectedVersion: number | null;
};

async function readChoice(userId: string): Promise<Choice | null> {
  return prisma.userOnboarding.findUnique({
    where: { userId },
    select: {
      unsubscribedAt: true,
      emailPreferenceAt: true,
      emailPreferenceVersion: true,
      emailProviderWriteAt: true,
      emailProviderAckVersion: true,
      emailProviderContendedVersion: true,
      emailProviderWriteVersion: true,
      emailProviderRejectedVersion: true,
    },
  });
}

const choiceOf = (row: Choice): TopicSubscription => (row.unsubscribedAt ? "opt_out" : "opt_in");

/**
 * Takes the lease for provider writes, by the database's clock, if nobody holds
 * it. Answers the lease's end, which is its token, or null when another write
 * is on its way.
 */
async function takeLease(userId: string, timing: Timing): Promise<Hold | null> {
  const [row] = await prisma.$queryRaw<{ until: Date }[]>`
    UPDATE user_onboarding
    SET email_provider_lease_until = (clock_timestamp() AT TIME ZONE 'UTC') + ${timing.leaseMs} * interval '1 millisecond'
    WHERE user_id = ${userId}
      AND (email_provider_lease_until IS NULL OR email_provider_lease_until < (clock_timestamp() AT TIME ZONE 'UTC'))
    RETURNING email_provider_lease_until AS until`;
  if (!row) return null;
  return {
    lease: row.until,
    deadline: AbortSignal.timeout(timing.holdBudgetMs),
    endsAt: Date.now() + timing.holdBudgetMs,
  };
}

/**
 * Records, under the lease, that a write of `version` is about to start. Each
 * attempt supersedes the previous one's refusal in the same statement, so a
 * refusal only ever describes the latest attempt.
 */
async function startWrite(userId: string, hold: Hold, version: number): Promise<Date | null> {
  // Out of budget: nothing more is sent under this lease.
  const left = hold.endsAt - Date.now();
  if (hold.deadline.aborted || left <= 0) return null;
  const at = hold.lease.toISOString().replace("Z", "");
  const [row] = await prisma.$queryRaw<{ at: Date }[]>`
    UPDATE user_onboarding
    SET email_provider_write_at = (clock_timestamp() AT TIME ZONE 'UTC'),
        email_provider_write_version = ${version},
        email_provider_rejected_version = NULL
    WHERE user_id = ${userId} AND email_provider_lease_until = ${at}::timestamp(3)
      AND email_preference_version = ${version}
      -- Still held for at least the rest of the budget.
      AND email_provider_lease_until > (clock_timestamp() AT TIME ZONE 'UTC') + ${left} * interval '1 millisecond'
    RETURNING email_provider_write_at AS at`;
  return row?.at ?? null;
}

/**
 * Records that the provider refused the attempt that started at `attempt`: a
 * later run tries it again. Nothing is recorded if another attempt has started since.
 */
async function recordRejected(userId: string, version: number, attempt: Date) {
  await prisma.userOnboarding.updateMany({
    where: { userId, emailProviderWriteVersion: version, emailProviderWriteAt: attempt },
    data: { emailProviderRejectedVersion: version },
  });
}

/**
 * Gives the lease back, and acknowledges `version` if the write succeeded with
 * it still in force. Answers false, and acknowledges nothing, when the lease is
 * no longer this writer's (it ran out, and someone else may have taken it).
 */
async function giveBack(userId: string, lease: Date, ackVersion: number | null): Promise<boolean> {
  const { count } = await prisma.userOnboarding.updateMany({
    where: { userId, emailProviderLeaseUntil: lease },
    data: { emailProviderLeaseUntil: null },
  });
  if (count === 0) return false;
  if (ackVersion !== null) {
    await prisma.userOnboarding.updateMany({
      where: { userId, emailPreferenceVersion: ackVersion },
      data: { emailProviderAckVersion: ackVersion },
    });
  }
  return true;
}

/** Marks a choice as made while another write was on its way. */
async function markContended(userId: string, version: number) {
  await prisma.userOnboarding.updateMany({
    where: { userId, emailPreferenceVersion: version },
    data: { emailProviderContendedVersion: version },
  });
}

/**
 * Sends one choice under the lease. Answers whether the provider took it and
 * whether it was still the choice in force when the answer came.
 */
async function sendUnderLease(
  userId: string,
  email: string,
  hold: Hold,
  choice: TopicSubscription,
  version: number,
  setTopic: SetProviderTopic,
): Promise<{ outcome: WriteOutcome | "stale"; current: Choice | null }> {
  const lease = hold.lease;
  const started = await startWrite(userId, hold, version);
  if (!started) {
    // The choice changed after it was read, or the budget is spent: nothing is sent.
    await giveBack(userId, lease, null);
    const current = await readChoice(userId);
    if (current?.emailPreferenceVersion === version) return { outcome: "rejected", current };
    return { outcome: "stale", current };
  }
  let outcome = await setTopic(email, choice, hold.deadline);
  if (outcome === "rejected") await recordRejected(userId, version, started);
  const current = await readChoice(userId);
  const stillInForce = !!current && current.emailPreferenceVersion === version;
  const held = await giveBack(userId, lease, outcome === "ok" && stillInForce ? version : null);
  // An answer that came after the lease ran out cannot be ordered against a
  // writer that took it since: it is not acknowledged.
  if (!held && outcome === "ok") outcome = "unknown";
  return { outcome, current };
}

/** What the unsubscribe page can tell the person about a choice it recorded. */
export type SyncResult =
  /** The provider took this choice (or a newer opt-out sent after it). */
  | { state: "applied"; subscribed: boolean }
  /** Another write was on its way: not sent now; an opt-in that raced it loses. */
  | { state: "queued" }
  /** The provider refused it: the scheduled run sends it again. */
  | { state: "rejected" }
  /** No answer: it may or may not have been applied. */
  | { state: "unknown" }
  /** A newer Subscribe again was made before this could be sent; that one is sent instead. */
  | { state: "superseded"; subscribed: boolean };

/**
 * On the unsubscribe page: sends the person's choice, unless another write is
 * on its way (then the choice is marked as racing it and left to the writer in
 * flight and the scheduled run). When the answer comes and a newer opt-out was
 * made meanwhile, that is sent too.
 */
export async function syncEmailPreference(
  userId: string,
  email: string,
  setTopic: SetProviderTopic = setProviderTopic,
  timing: Timing = DEFAULT_TIMING,
): Promise<SyncResult> {
  let row = await readChoice(userId);
  if (!row?.emailPreferenceAt) return { state: "rejected" };
  for (;;) {
    const version: number = row.emailPreferenceVersion;
    const choice = choiceOf(row);
    const hold = await takeLease(userId, timing);
    if (!hold) {
      await markContended(userId, version);
      return { state: "queued" };
    }
    const lease = hold.lease;
    // Read again under the lease: a newer choice may have been made, and even
    // sent, since this one was read. A stale choice is never sent.
    const fresh = await readChoice(userId);
    if (!fresh || fresh.emailPreferenceVersion !== version) {
      await giveBack(userId, lease, null);
      if (!fresh) return { state: "rejected" };
      // A newer opt-out is sent now (always safe); a newer Subscribe again is
      // its own request's to send.
      if (choiceOf(fresh) === "opt_in") return { state: "superseded", subscribed: true };
      row = fresh;
      continue;
    }
    const { outcome, current } = await sendUnderLease(
      userId,
      email,
      hold,
      choice,
      version,
      setTopic,
    );
    if (outcome === "stale") {
      // A newer choice landed just before the send; as above.
      if (!current) return { state: "rejected" };
      if (choiceOf(current) === "opt_in") return { state: "superseded", subscribed: true };
      row = current;
      continue;
    }
    if (outcome !== "ok") return { state: outcome };
    if (!current || current.emailPreferenceVersion === version || choiceOf(current) === "opt_in")
      // In force, or overtaken by a Subscribe again, which raced this write and
      // is left to the scheduled run (the opt-out it raced wins there).
      return { state: "applied", subscribed: choice === "opt_in" };
    // A newer opt-out was made while this write was on its way: send it now.
    row = current;
  }
}

type Settle = { setTopic: SetProviderTopic; readTopic: ReadProviderTopic; timing: Timing };

/**
 * Looks at one preference for the scheduled run (see the top of this file).
 * Marks it settled only if no other choice came along meanwhile; otherwise a
 * later run looks again.
 */
async function settleEmailPreference(userId: string, email: string, io: Settle): Promise<boolean> {
  const hold = await takeLease(userId, io.timing);
  if (!hold) return false; // a write is on its way; a later run looks again
  const lease = hold.lease;
  let ackVersion: number | null = null;
  try {
    const row = await readChoice(userId);
    if (!row?.emailPreferenceAt) return false;
    const version = row.emailPreferenceVersion;
    const want = choiceOf(row);
    const held = await io.readTopic(email, hold.deadline);
    if (!held) return false;

    // Settled at the latest write, if the choice is still the one looked at.
    const settle = async (writeAt: Date | null) => {
      const { count } = await prisma.userOnboarding.updateMany({
        where: { userId, emailPreferenceVersion: version, emailProviderWriteAt: writeAt },
        data: { emailProviderSettledAt: writeAt ?? new Date(0) },
      });
      if (count > 0) ackVersion = version;
      return count > 0;
    };
    if (held === want) return await settle(row.emailProviderWriteAt);

    // Which came last at the provider cannot be known when the choice raced
    // another write, was acknowledged before the provider changed, or was
    // written with no answer (its writer died, or none came).
    const unknownOutcome =
      row.emailProviderWriteVersion === version &&
      row.emailProviderAckVersion !== version &&
      row.emailProviderRejectedVersion !== version;
    const unknowable =
      row.emailProviderContendedVersion === version ||
      row.emailProviderAckVersion === version ||
      unknownOutcome;
    if (unknowable && held === "opt_out") {
      // The opt-out wins: record it on the account, guarded by the version so a
      // choice made meanwhile is not overwritten.
      const recorded = await prisma.$executeRaw`
        UPDATE user_onboarding
        SET unsubscribed_at = COALESCE(unsubscribed_at, (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)),
            email_preference_at = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
            email_preference_version = email_preference_version + 1,
            email_provider_ack_version = email_preference_version + 1,
            email_provider_settled_at = COALESCE(email_provider_write_at, 'epoch'::timestamp)
        WHERE user_id = ${userId} AND email_preference_version = ${version}`;
      return recorded > 0;
    }
    // A refused or never-sent write of the account's choice is finished; an
    // opt-in at the provider under an account opt-out is set back (the opt-out wins).
    const writeAt = await startWrite(userId, hold, version);
    if (!writeAt) return false;
    const outcome = await io.setTopic(email, want, hold.deadline);
    if (outcome === "rejected") await recordRejected(userId, version, writeAt);
    if (outcome !== "ok") return false;
    return await settle(writeAt);
  } finally {
    await giveBack(userId, lease, ackVersion);
  }
}

/**
 * The scheduled run: looks, a bounded batch at a time, at each preference with
 * a choice or a provider write since it was last confirmed, once its latest
 * write is SETTLE_AFTER_MS old. Least recently looked at first, so a person the
 * provider keeps refusing, or whose state it cannot give, goes to the back each
 * time and is tried again later. Stops starting new people after budgetMs, so a
 * slow provider leaves time for the tick's other jobs; the rest wait for the
 * next run. Answers how many it confirmed, how many it tried without
 * confirming, and how many it left for the next run.
 */
export async function syncPendingEmailPreferences(
  options: {
    limit?: number;
    budgetMs?: number;
    settleAfterMs?: number;
    setTopic?: SetProviderTopic;
    readTopic?: ReadProviderTopic;
    timing?: Timing;
  } = {},
): Promise<{ synced: number; pending: number; remaining: number }> {
  const limit = options.limit ?? PER_TICK;
  const budgetMs = options.budgetMs ?? TICK_BUDGET_MS;
  const settleAfterMs = options.settleAfterMs ?? SETTLE_AFTER_MS;
  const io = {
    setTopic: options.setTopic ?? setProviderTopic,
    readTopic: options.readTopic ?? readProviderTopic,
    timing: options.timing ?? DEFAULT_TIMING,
  };
  const rows = await prisma.$queryRaw<{ user_id: string; email: string }[]>`
    SELECT o.user_id, u.email
    FROM user_onboarding o JOIN users u ON u.id = o.user_id
    WHERE o.email_preference_at IS NOT NULL
      AND (o.email_provider_settled_at IS NULL
           OR o.email_provider_write_at > o.email_provider_settled_at)
      AND (o.email_provider_write_at IS NULL
           OR o.email_provider_write_at <= (clock_timestamp() AT TIME ZONE 'UTC') - ${settleAfterMs} * interval '1 millisecond')
    ORDER BY o.email_provider_checked_at NULLS FIRST, o.email_provider_write_at, o.user_id
    LIMIT ${limit}`;
  const started = Date.now();
  let synced = 0;
  let tried = 0;
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break;
    tried += 1;
    // Looked at now, whatever comes of it: a person whose provider cannot be
    // read, or whose write is still on its way, goes behind the others next time.
    await prisma.userOnboarding.updateMany({
      where: { userId: row.user_id },
      data: { emailProviderCheckedAt: new Date() },
    });
    const ok = await settleEmailPreference(row.user_id, row.email, io).catch(() => false);
    if (ok) synced += 1;
  }
  return { synced, pending: tried - synced, remaining: rows.length - tried };
}
