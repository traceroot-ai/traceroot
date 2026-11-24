/**
 * When the cloud welcome email goes out, and which version.
 *
 * Sign-up records when the welcome falls due at the latest (`welcomeDueAt`, 15
 * minutes on). Finishing or skipping the last sign-up question sends it then,
 * in the version the answers call for. Someone who never gets that far is sent
 * the generic version by the scheduled run once it falls due. Either way it
 * goes through sendOnce, which claims one row per person for "welcome", so the
 * two racing, or a run retried, still send one email.
 *
 * Only people whose sign-up recorded a due time are ever sent one, so nobody
 * who signed up before this existed is welcomed now. The follow-up switch does
 * not apply: the welcome is not a follow-up. Self-hosted installs send their
 * welcome at sign-up instead (lib/signup/on-user-created.ts) and never here.
 */
import { prisma } from "@traceroot/core";
import { ensureContact, isProductMailConfigured, type SendOnceResult } from "@traceroot/core/email";
import { isCloud } from "@/lib/server/cloud";
import type { WelcomeVariant } from "./founder-copy";
import { sendWelcomeEmail } from "./send-welcome-email";

/** How long after sign-up the scheduled run sends the welcome, if nothing has. */
export const WELCOME_FALLBACK_MS = 15 * 60 * 1000;
/**
 * How long after falling due a welcome that could not be sent (the provider
 * down, say) is still tried. After that it is dropped rather than sent late.
 */
export const WELCOME_RETRY_MS = 24 * 60 * 60 * 1000;

/** The look-around version for someone whose only use is "Just looking around for now". */
export function welcomeVariant(answers: {
  questionsDoneAt: Date | null;
  uses: readonly string[];
}): WelcomeVariant {
  if (!answers.questionsDoneAt) return "generic";
  return answers.uses.length === 1 && answers.uses[0] === "exploring" ? "exploring" : "generic";
}

/** Records, at sign-up, that this person gets a welcome, due 15 minutes on at the latest. */
export async function scheduleWelcome(userId: string, signedUpAt: Date = new Date()) {
  const welcomeDueAt = new Date(signedUpAt.getTime() + WELCOME_FALLBACK_MS);
  // Not an upsert: the questions can create the row at the same moment.
  await prisma.userOnboarding.createMany({
    data: [{ userId, welcomeDueAt }],
    skipDuplicates: true,
  });
  await prisma.userOnboarding.updateMany({
    where: { userId, welcomeDueAt: null },
    data: { welcomeDueAt },
  });
}

export type WelcomeAttempt =
  | SendOnceResult
  | { status: "not_scheduled" }
  | { status: "no_contact" };

/**
 * Sends this person's welcome if they are due one and it has not gone out, in
 * the version their answers call for as they stand now. Safe to call twice and
 * from two places at once. Never throws for a send that fails: it is released
 * and the scheduled run tries again.
 */
export async function sendScheduledWelcome(
  userId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<WelcomeAttempt> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      onboarding: { select: { welcomeDueAt: true, questionsDoneAt: true, uses: true } },
    },
  });
  const row = user?.onboarding;
  if (!user || !row?.welcomeDueAt) return { status: "not_scheduled" };
  // Resend delivers topic mail to non-contacts, and the opt-out needs a record.
  const contact = await ensureContact(
    { email: user.email, name: user.name },
    { fetchImpl: options.fetchImpl },
  );
  if (!contact.ok) return { status: "no_contact" };
  return sendWelcomeEmail(
    { userId, email: user.email, name: user.name, variant: welcomeVariant(row) },
    { fetchImpl: options.fetchImpl },
  );
}

export interface WelcomeRun {
  /** People whose welcome had fallen due and had not gone out. */
  due: number;
  sent: number;
  /** Already sent or being sent by another call (the questions, or an overlapping run). */
  claimedElsewhere: number;
  /** Not sent this time (no contact, refused or failed); tried again next run. */
  notSent: number;
}

/** The scheduled run's part: every welcome that has fallen due and not gone out. */
export async function runWelcomeFallback(
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<WelcomeRun> {
  const now = options.now ?? new Date();
  const run: WelcomeRun = { due: 0, sent: 0, claimedElsewhere: 0, notSent: 0 };
  if (!isCloud() || !isProductMailConfigured()) return run;
  const due = await prisma.userOnboarding.findMany({
    where: {
      welcomeDueAt: { lte: now, gt: new Date(now.getTime() - WELCOME_RETRY_MS) },
      user: { emailSends: { none: { campaign: "welcome" } } },
    },
    select: { userId: true },
    orderBy: { welcomeDueAt: "asc" },
  });
  for (const { userId } of due) {
    run.due += 1;
    const result = await sendScheduledWelcome(userId, { fetchImpl: options.fetchImpl });
    if (result.status === "sent") run.sent += 1;
    else if (result.status === "already-sent" || result.status === "in-flight")
      run.claimedElsewhere += 1;
    else run.notSent += 1;
  }
  return run;
}
