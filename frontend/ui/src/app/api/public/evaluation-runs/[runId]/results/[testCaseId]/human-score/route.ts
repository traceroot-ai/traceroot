import { NextResponse } from "next/server";
import { prisma, CreateHumanScoreRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string; testCaseId: string }> };

// POST /api/public/evaluation-runs/[runId]/results/[testCaseId]/human-score (B4) —
// record a human review bound to (run, test case), so deferred / human scoring is
// reportable from the SDK (previously only on the session surface). Additive; each
// call appends a review and never rewrites automated results (B2).
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { runId, testCaseId } = await params;

  const result = await prisma.evaluationResult.findFirst({
    where: { runId, testCaseId, projectId },
    select: { id: true },
  });
  if (!result) {
    return NextResponse.json({ error: "Result not found for run and test case" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateHumanScoreRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const h = parsed.data;

  const created = await prisma.humanScore.create({
    data: {
      resultId: result.id,
      projectId,
      verdict: h.verdict,
      quality: h.quality ?? null,
      comment: h.comment ?? null,
      reviewer: h.reviewer,
    },
    select: { id: true },
  });

  return NextResponse.json({ human_score_id: created.id }, { status: 201 });
}
