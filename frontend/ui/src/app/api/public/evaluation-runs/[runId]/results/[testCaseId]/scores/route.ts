import { NextResponse } from "next/server";
import { prisma, Prisma, ScoreInputSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string; testCaseId: string }> };

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// POST /api/public/evaluation-runs/[runId]/results/[testCaseId]/scores (B3) —
// report ONE scorer's outcome, MERGED on (scorer_name, scorer_version) instead of
// replacing the whole scores array (which re-upserting the result does). Safe for
// delayed / human / per-scorer scores that arrive after the result, and accepted
// even once the run is completed (B2) — it never rewrites the automated results.
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
  const parsed = ScoreInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const s = parsed.data;

  const fields = {
    numericValue: s.numeric_value ?? null,
    boolValue: s.bool_value ?? null,
    stringValue: s.string_value ?? null,
    passed: s.passed ?? null,
    explanation: s.explanation ?? null,
    error: s.error ?? null,
  };

  // One row per scorer per result, enforced by uq_score_result_scorer — the merge
  // is a real upsert on that key, so a retried report updates the row it already
  // wrote instead of inserting a second one that nothing would ever reconcile.
  const upsertScore = () =>
    prisma.score.upsert({
      where: {
        resultId_scorerName_scorerVersion: {
          resultId: result.id,
          scorerName: s.scorer_name,
          scorerVersion: s.scorer_version,
        },
      },
      create: {
        resultId: result.id,
        projectId,
        scorerName: s.scorer_name,
        scorerVersion: s.scorer_version,
        ...fields,
      },
      update: fields,
      select: { id: true },
    });

  let scoreId: string;
  try {
    scoreId = (await upsertScore()).id;
  } catch (e) {
    // Concurrent reports of the same scorer: the loser retries onto the row the
    // winner just inserted rather than surfacing Prisma internals as a 500.
    if (!isUniqueViolation(e)) {
      return NextResponse.json({ error: "Failed to record score" }, { status: 500 });
    }
    try {
      scoreId = (await upsertScore()).id;
    } catch {
      return NextResponse.json({ error: "Failed to record score" }, { status: 500 });
    }
  }

  return NextResponse.json({ score_id: scoreId }, { status: 200 });
}
