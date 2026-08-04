import { NextRequest } from "next/server";
import { prisma, Role, CreateHumanScoreRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; resultId: string }> };

// POST — human-score one evaluation result. Deliberately separate from editing
// the dataset's expected output (that is a dataset write, not a scoring action).
export async function POST(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, resultId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = CreateHumanScoreRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);

  const result = await prisma.evaluationResult.findFirst({
    where: { id: resultId, projectId },
    select: { id: true },
  });
  if (!result) return errorResponse("Evaluation result not found", 404);

  // The authenticated session identity is authoritative, never the request body —
  // otherwise any MEMBER could attribute a human score to someone else.
  const reviewer = authResult.user.email ?? authResult.user.id;
  const { dimension, verdict, quality, comment } = parsed.data;
  // One canonical review per (result, dimension): re-reviewing replaces in place.
  // This never touches the automated score, comparison, or run status — human
  // review is a separate, co-equal signal.
  const fields = {
    verdict,
    quality: quality ?? null,
    comment: comment ?? null,
    reviewer,
    status: "reviewed",
  };
  const humanScore = await prisma.humanScore.upsert({
    where: { resultId_dimension: { resultId, dimension } },
    create: { resultId, projectId, dimension, ...fields },
    update: fields,
  });
  return successResponse({ humanScore }, 201);
}
