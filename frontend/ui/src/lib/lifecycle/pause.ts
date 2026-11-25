/**
 * Whether a person's follow-up emails are held back, and why. Two separate
 * facts on their onboarding row, because they stack:
 *
 * - paused by us (`followUpsPausedAt`, with a reason): outreach has started,
 *   someone paused them by hand, or the person wrote to us. Resume clears it.
 * - unsubscribed by the person (`unsubscribedAt`): "Subscribe again" clears it.
 *
 * Resume never clears an unsubscribe, and subscribing again never clears a
 * pause; follow-ups go out only when both are clear.
 */
import { prisma } from "@traceroot/core";

/** Why we paused. Neutral words: they are stored in a public codebase's database. */
export const PAUSE_REASONS = ["outreach", "manual", "conversation"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface FollowUpHold {
  paused: boolean;
  pauseReason: PauseReason | null;
  unsubscribed: boolean;
  /** The decision time of the latest pause or resume applied, if any. */
  intentAt: Date | null;
}

async function ensureRow(userId: string): Promise<void> {
  await prisma.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
}

async function readHold(userId: string): Promise<FollowUpHold> {
  const row = await prisma.userOnboarding.findUnique({
    where: { userId },
    select: {
      followUpsPausedAt: true,
      followUpsPauseReason: true,
      unsubscribedAt: true,
      followUpsIntentAt: true,
    },
  });
  return {
    paused: !!row?.followUpsPausedAt,
    pauseReason: (row?.followUpsPausedAt ? row.followUpsPauseReason : null) as PauseReason | null,
    unsubscribed: !!row?.unsubscribedAt,
    intentAt: row?.followUpsIntentAt ?? null,
  };
}

/**
 * Pauses or resumes one person's follow-ups as decided at `intentAt`, and
 * answers where they now stand and whether this call changed it.
 *
 * Only a decision later than the latest one applied takes effect. Calls can
 * arrive out of order (a retry, or one that timed out at the caller and
 * committed late), and an older decision must never undo a newer one, so each
 * write is conditional on the stored decision time in the same statement. A
 * repeated call is therefore a no-op, and a pause that finds the person already
 * paused keeps the first pause's time and reason. Answers null for an unknown user.
 */
export async function setFollowUpPause(
  userId: string,
  action: "pause" | "resume",
  intentAt: Date,
  reason: PauseReason = "manual",
  now: Date = new Date(),
): Promise<(FollowUpHold & { applied: boolean }) | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;
  await ensureRow(userId);
  const older = {
    OR: [{ followUpsIntentAt: null }, { followUpsIntentAt: { lt: intentAt } }],
  };
  let applied: number;
  if (action === "pause") {
    const fresh = await prisma.userOnboarding.updateMany({
      where: { userId, followUpsPausedAt: null, ...older },
      data: { followUpsPausedAt: now, followUpsPauseReason: reason, followUpsIntentAt: intentAt },
    });
    const already = await prisma.userOnboarding.updateMany({
      where: { userId, followUpsPausedAt: { not: null }, ...older },
      data: { followUpsIntentAt: intentAt },
    });
    applied = fresh.count + already.count;
  } else {
    ({ count: applied } = await prisma.userOnboarding.updateMany({
      where: { userId, ...older },
      data: { followUpsPausedAt: null, followUpsPauseReason: null, followUpsIntentAt: intentAt },
    }));
  }
  const hold = await readHold(userId);
  return { ...hold, applied: applied > 0 };
}

/**
 * When a product-email choice is made, read from the database's clock, so the
 * order of choices does not depend on which web server took each request.
 */
export async function emailChoiceTime(): Promise<Date> {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}

/** Where a person's product-email choice stands after recording one. */
export interface EmailPreference {
  userId: string;
  /** False when a newer choice was already recorded; this one changed nothing. */
  applied: boolean;
  /** The choice now in force on the account. */
  subscribed: boolean;
}

/**
 * Records an unsubscribe (or a "Subscribe again") from the product-email
 * unsubscribe page, which identifies the person by address. `decidedAt` is when
 * the person made the choice (emailChoiceTime(), when the request arrived): only
 * a choice newer than the latest one applied takes effect, so a slow request
 * that lands late can never undo a newer choice; at the same instant an
 * unsubscribe wins. An address with no account records nothing and answers null.
 */
export async function recordUnsubscribe(
  email: string,
  subscribed: boolean,
  decidedAt: Date = new Date(),
): Promise<EmailPreference | null> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) return null;
  await ensureRow(user.id);
  // Two choices made at the same instant: the unsubscribe wins.
  const older = {
    OR: [
      { emailPreferenceAt: null },
      { emailPreferenceAt: { lt: decidedAt } },
      ...(subscribed ? [] : [{ emailPreferenceAt: decidedAt }]),
    ],
  };
  // Every choice applied gets a new version and waits for the provider to be
  // confirmed again (email-preference-sync.ts).
  let applied: number;
  if (subscribed) {
    ({ count: applied } = await prisma.userOnboarding.updateMany({
      where: { userId: user.id, ...older },
      data: {
        unsubscribedAt: null,
        emailPreferenceAt: decidedAt,
        emailPreferenceVersion: { increment: 1 },
        emailProviderSettledAt: null,
      },
    }));
  } else {
    // A second unsubscribe keeps the time of the first. The already-unsubscribed
    // case goes first, so a row the other update changes cannot match it too.
    const already = await prisma.userOnboarding.updateMany({
      where: { userId: user.id, unsubscribedAt: { not: null }, ...older },
      data: {
        emailPreferenceAt: decidedAt,
        emailPreferenceVersion: { increment: 1 },
        emailProviderSettledAt: null,
      },
    });
    const fresh = await prisma.userOnboarding.updateMany({
      where: { userId: user.id, unsubscribedAt: null, ...older },
      data: {
        unsubscribedAt: decidedAt,
        emailPreferenceAt: decidedAt,
        emailPreferenceVersion: { increment: 1 },
        emailProviderSettledAt: null,
      },
    });
    applied = fresh.count + already.count;
  }
  const row = await prisma.userOnboarding.findUnique({
    where: { userId: user.id },
    select: { unsubscribedAt: true },
  });
  return { userId: user.id, applied: applied > 0, subscribed: !row?.unsubscribedAt };
}
