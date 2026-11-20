import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";
import { answersPatchSchema } from "@/lib/onboarding-questions";
import {
  finishOnboardingQuestions,
  readOnboardingAnswers,
  saveOnboardingAnswers,
} from "@/lib/onboarding-answers";

// GET /api/onboarding/questions - The caller's answers so far, and whether the
// questions are behind them.
async function handleGET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;
  return successResponse(await readOnboardingAnswers(user.id, user.email));
}

// PATCH /api/onboarding/questions - Save the answers given so far. Each person
// answers only for themselves, so there is no role to check.
async function handlePATCH(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const parsed = answersPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid", 400);
  await saveOnboardingAnswers(authResult.user.id, parsed.data);
  return successResponse({ saved: true });
}

// POST /api/onboarding/questions - Finish (or skip through) the last question.
async function handlePOST() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;
  return successResponse(await finishOnboardingQuestions(user.id, user.email));
}

export const GET = withImpersonationPolicy(handleGET);
export const PATCH = withImpersonationPolicy(handlePATCH);
export const POST = withImpersonationPolicy(handlePOST);
