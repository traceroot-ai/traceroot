/**
 * The sign-up questions' answers, kept on the person's `user_onboarding` row.
 * That row is the one complete copy, typed text included; analytics gets ids
 * and a domain, never what was typed.
 */
import { prisma } from "@traceroot/core";
import type {
  AnswersPatch,
  OnboardingAnswers,
  RoleId,
  SourceId,
  UseId,
} from "@/lib/onboarding-questions";
import { companyDomainFrom, isPersonalEmail } from "@/lib/personal-email";
import { captureServerEvent } from "@/lib/posthog-server";

export const ANSWERS_SUBMITTED_EVENT = "onboarding_answers_submitted";

/**
 * The person's row, made if it is missing. Not an upsert: two saves at once (a
 * quick Continue after a pick) would both try to create it, and one would fail
 * on the unique user id.
 */
async function ensureRow(userId: string): Promise<void> {
  await prisma.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
}

export async function readOnboardingAnswers(
  userId: string,
  email: string | null,
): Promise<OnboardingAnswers> {
  const row = await prisma.userOnboarding.findUnique({ where: { userId } });
  return {
    userId,
    role: (row?.role as RoleId | null) ?? null,
    company: row?.companyInput ?? null,
    uses: (row?.uses as UseId[] | undefined) ?? [],
    source: (row?.source as SourceId | null) ?? null,
    sourceOther: row?.sourceOther ?? null,
    companyAsked: isPersonalEmail(email),
    done: !!row?.questionsDoneAt,
  };
}

/**
 * Saves the answers given so far. Kept after the questions are done too: going
 * back to change one is still that person's answer, it just sends no event.
 */
export async function saveOnboardingAnswers(userId: string, patch: AnswersPatch): Promise<void> {
  const data = {
    ...(patch.role !== undefined && { role: patch.role }),
    ...(patch.company !== undefined && {
      companyInput: patch.company || null,
      companyDomain: patch.company ? companyDomainFrom(patch.company) : null,
    }),
    ...(patch.uses !== undefined && { uses: [...new Set(patch.uses)] }),
    ...(patch.source !== undefined && { source: patch.source }),
    ...(patch.sourceOther !== undefined && { sourceOther: patch.sourceOther || null }),
  };
  await ensureRow(userId);
  await prisma.userOnboarding.update({ where: { userId }, data });
}

/**
 * Marks the questions done, once. The call that marks them sends
 * `onboarding_answers_submitted` with what is saved; a second call (a
 * double-click, a refresh, another tab) finds them done and sends nothing.
 * Answers saved but never finished send no event.
 */
export async function finishOnboardingQuestions(
  userId: string,
  email: string | null,
  now: Date = new Date(),
): Promise<{ finished: boolean }> {
  await ensureRow(userId);
  const { count } = await prisma.userOnboarding.updateMany({
    where: { userId, questionsDoneAt: null },
    data: { questionsDoneAt: now },
  });
  if (!count) return { finished: false };

  const row = await prisma.userOnboarding.findUnique({ where: { userId } });
  const companyAsked = isPersonalEmail(email);
  captureServerEvent(userId, ANSWERS_SUBMITTED_EVENT, {
    role: row?.role ?? null,
    company_asked: companyAsked,
    company_domain: companyAsked ? (row?.companyDomain ?? null) : null,
    uses: row?.uses ?? [],
    // A typed answer with no button picked counts as "other"; the text stays here.
    source: row?.source ?? (row?.sourceOther ? "other" : null),
  });
  return { finished: true };
}
