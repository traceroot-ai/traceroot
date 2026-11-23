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
}

async function ensureRow(userId: string): Promise<void> {
  await prisma.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
}

async function readHold(userId: string): Promise<FollowUpHold> {
  const row = await prisma.userOnboarding.findUnique({
    where: { userId },
    select: { followUpsPausedAt: true, followUpsPauseReason: true, unsubscribedAt: true },
  });
  return {
    paused: !!row?.followUpsPausedAt,
    pauseReason: (row?.followUpsPausedAt ? row.followUpsPauseReason : null) as PauseReason | null,
    unsubscribed: !!row?.unsubscribedAt,
  };
}

/**
 * Pauses or resumes one person's follow-ups, and answers where they now stand.
 * Repeating a call changes nothing: a second pause keeps the first time and
 * reason. Answers null for an unknown user.
 */
export async function setFollowUpPause(
  userId: string,
  action: "pause" | "resume",
  reason: PauseReason = "manual",
  now: Date = new Date(),
): Promise<FollowUpHold | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;
  await ensureRow(userId);
  if (action === "pause") {
    await prisma.userOnboarding.updateMany({
      where: { userId, followUpsPausedAt: null },
      data: { followUpsPausedAt: now, followUpsPauseReason: reason },
    });
  } else {
    await prisma.userOnboarding.updateMany({
      where: { userId },
      data: { followUpsPausedAt: null, followUpsPauseReason: null },
    });
  }
  return readHold(userId);
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
