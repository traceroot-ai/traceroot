import { NextResponse } from "next/server";
import { prisma, Prisma, CreateHumanScoreRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

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

  // One canonical review per (result, dimension): re-reviewing replaces in place,
  // and this never rewrites the automated score, comparison, or run status.
  const fields = {
    verdict: h.verdict,
    quality: h.quality ?? null,
    comment: h.comment ?? null,
    reviewer: h.reviewer,
    status: "reviewed",
  };
  // upsert is not atomic against a concurrent insert, so two first reviews of the same
  // (result, dimension) can race: the loser hits the uq_human_score_result_dimension
  // P2002. Retry once — the second pass takes the update path against the winner's row —
  // instead of surfacing it as a 500 (mirrors the /scores route). (LOW-d)
  const upsertHumanScore = () =>
    prisma.humanScore.upsert({
      where: { resultId_dimension: { resultId: result.id, dimension: h.dimension } },
      create: { resultId: result.id, projectId, dimension: h.dimension, ...fields },
      update: fields,
      select: { id: true },
    });

  let created: { id: string };
  try {
    created = await upsertHumanScore();
  } catch (e) {
    if (!isUniqueViolation(e)) {
      return NextResponse.json({ error: "Failed to record human score" }, { status: 500 });
    }
    try {
      created = await upsertHumanScore();
    } catch {
      return NextResponse.json({ error: "Failed to record human score" }, { status: 500 });
    }
  }

  return NextResponse.json({ human_score_id: created.id }, { status: 201 });
}
