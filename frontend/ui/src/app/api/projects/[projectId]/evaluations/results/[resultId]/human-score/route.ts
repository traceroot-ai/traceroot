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

  const humanScore = await prisma.humanScore.create({
    data: {
      resultId,
      projectId,
      verdict: parsed.data.verdict,
      quality: parsed.data.quality ?? null,
      comment: parsed.data.comment ?? null,
      reviewer: parsed.data.reviewer,
    },
  });
  return successResponse({ humanScore }, 201);
}
