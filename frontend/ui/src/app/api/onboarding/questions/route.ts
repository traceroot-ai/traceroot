import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { after, NextRequest } from "next/server";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";
import {
  ANSWERS_USER_HEADER,
  MAX_ANSWERS_BODY_BYTES,
  answersPatchSchema,
} from "@/lib/onboarding-questions";
import { readJsonLimited } from "@/lib/read-json-limited";
import {
  finishOnboardingQuestions,
  readOnboardingAnswers,
  saveOnboardingAnswers,
} from "@/lib/onboarding-answers";
import { sendScheduledWelcome } from "@/lib/email/welcome/welcome-schedule";

/**
 * The account the page's answers were read for, which a save names. Another
 * tab can sign this browser in as someone else while the questions are open;
 * a save from the stale page is refused, rather than filed under the account
 * that is signed in now.
 */
function accountChanged(request: NextRequest, userId: string) {
  return request.headers.get(ANSWERS_USER_HEADER) !== userId
    ? errorResponse("Signed in as a different account", 409)
    : null;
}

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
  const changed = accountChanged(request, authResult.user.id);
  if (changed) return changed;
  const body = await readJsonLimited(request, MAX_ANSWERS_BODY_BYTES);
  if (!body.ok) return errorResponse(body.error, body.status);
  const parsed = answersPatchSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid", 400);
  await saveOnboardingAnswers(authResult.user.id, parsed.data);
  return successResponse({ saved: true });
}

// POST /api/onboarding/questions - Finish (or skip through) the last question.
// The call that finishes them sends the welcome email, in the version the
// answers call for, once the response is on its way; the next page does not
// wait for it. A welcome that fails here is sent by the scheduled run.
async function handlePOST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;
  const changed = accountChanged(request, user.id);
  if (changed) return changed;
  const result = await finishOnboardingQuestions(user.id, user.email);
  if (result.finished) {
    after(() =>
      sendScheduledWelcome(user.id).catch((error: unknown) => {
        console.error(`[welcome] send after the questions failed for user ${user.id}:`, error);
      }),
    );
  }
  return successResponse(result);
}

export const GET = withImpersonationPolicy(handleGET);
export const PATCH = withImpersonationPolicy(handlePATCH);
export const POST = withImpersonationPolicy(handlePOST);
