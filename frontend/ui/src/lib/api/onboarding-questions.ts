/**
 * The sign-up questions' answers (app/api/onboarding/questions).
 */
import { fetchNextApi } from "./client";
import {
  ANSWERS_USER_HEADER,
  type AnswersPatch,
  type OnboardingAnswers,
} from "@/lib/onboarding-questions";

export function getOnboardingAnswers(): Promise<OnboardingAnswers> {
  return fetchNextApi<OnboardingAnswers>("/onboarding/questions");
}

/** Saves for `userId`, the account the answers were read for; refused (409) if another is signed in now. */
export function saveOnboardingAnswers(
  userId: string,
  patch: AnswersPatch,
): Promise<{ saved: true }> {
  return fetchNextApi("/onboarding/questions", {
    method: "PATCH",
    // Let this small answer finish sending if the user reloads immediately.
    keepalive: true,
    headers: { [ANSWERS_USER_HEADER]: userId },
    body: JSON.stringify(patch),
  });
}

export function finishOnboardingQuestions(userId: string): Promise<{ finished: boolean }> {
  return fetchNextApi("/onboarding/questions", {
    method: "POST",
    headers: { [ANSWERS_USER_HEADER]: userId },
  });
}
