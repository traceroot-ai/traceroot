/**
 * The sign-up questions' answers (app/api/onboarding/questions).
 */
import { fetchNextApi } from "./client";
import type { AnswersPatch, OnboardingAnswers } from "@/lib/onboarding-questions";

export function getOnboardingAnswers(): Promise<OnboardingAnswers> {
  return fetchNextApi<OnboardingAnswers>("/onboarding/questions");
}

export function saveOnboardingAnswers(patch: AnswersPatch): Promise<{ saved: true }> {
  return fetchNextApi("/onboarding/questions", { method: "PATCH", body: JSON.stringify(patch) });
}

export function finishOnboardingQuestions(): Promise<{ finished: boolean }> {
  return fetchNextApi("/onboarding/questions", { method: "POST" });
}
