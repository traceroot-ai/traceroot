import { NextResponse } from "next/server";
import { prisma, ScoreInputSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string; testCaseId: string }> };

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

  // Atomic upsert on the compound unique — a find-then-create let two concurrent
  // submissions for the same scorer both pass the read and then one lose the unique-key
  // race with a 500. Postgres INSERT ... ON CONFLICT DO UPDATE serialises them.
  const upserted = await prisma.score.upsert({
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

  return NextResponse.json({ score_id: upserted.id }, { status: 200 });
}
