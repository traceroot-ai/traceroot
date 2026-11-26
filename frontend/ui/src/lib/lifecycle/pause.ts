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
 * Records an unsubscribe (or a "Subscribe again") from the product-email
 * unsubscribe page, which identifies the person by address. An address with no
 * account records nothing. Answers the user id it recorded for.
 */
export async function recordUnsubscribe(
  email: string,
  subscribed: boolean,
  now: Date = new Date(),
): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) return null;
  await ensureRow(user.id);
  if (subscribed) {
    await prisma.userOnboarding.updateMany({
      where: { userId: user.id },
      data: { unsubscribedAt: null },
    });
  } else {
    await prisma.userOnboarding.updateMany({
      where: { userId: user.id, unsubscribedAt: null },
      data: { unsubscribedAt: now },
    });
  }
  return user.id;
}
