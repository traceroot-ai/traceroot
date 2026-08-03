import { NextResponse } from "next/server";
import { prisma, UpsertResultRequestSchema, type UpsertResultResponse } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string }> };

// POST /api/public/evaluation-runs/[runId]/results — SDK upserts one test-case
// result. Idempotent on (run_id, test_case_id); re-sending replaces the result's
// scores. trace_id may be null now and set on a later call (out-of-order OK).
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { runId } = await params;

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { id: true, evaluationId: true },
  });
  if (!run) return NextResponse.json({ error: "Evaluation run not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = UpsertResultRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const r = parsed.data;

  const resultFields = {
    input: r.input,
    expectedOutput: r.expected_output ?? null,
    candidateOutput: r.candidate_output ?? null,
    baselineOutput: r.baseline_output ?? null,
    status: r.status,
    mainScore: r.main_score ?? null,
    change: r.change ?? null,
    taskError: r.task_error ?? null,
    durationMs: r.duration_ms ?? null,
    cost: r.cost ?? null,
    traceId: r.trace_id ?? null,
  };
  // `scores` is optional with no default: undefined = leave the result's stored scores
  // alone (a follow-up that only attaches a trace_id must not wipe them); [] = clear;
  // a list = replace. Build defensively so an omitted `scores` never `.map`s undefined.
  const scoreRows = (r.scores ?? []).map((s) => ({
    projectId,
    scorerName: s.scorer_name,
    scorerVersion: s.scorer_version,
    numericValue: s.numeric_value ?? null,
    boolValue: s.bool_value ?? null,
    stringValue: s.string_value ?? null,
    passed: s.passed ?? null,
    explanation: s.explanation ?? null,
    error: s.error ?? null,
  }));

  const resultId = await prisma.$transaction(async (tx) => {
    // Atomic upsert on (runId, testCaseId) — a find-then-create let two concurrent
    // first reports for the same case both pass the existence check and then one 500
    // on the unique key. INSERT ... ON CONFLICT DO UPDATE serialises them.
    const result = await tx.evaluationResult.upsert({
      where: { runId_testCaseId: { runId, testCaseId: r.test_case_id } },
      create: {
        runId,
        evaluationId: run.evaluationId,
        projectId,
        testCaseId: r.test_case_id,
        ...resultFields,
      },
      update: resultFields,
      select: { id: true },
    });
    // Only rewrite scores when the caller actually sent the field — omitting it leaves
    // the previously-reported scores intact (out-of-order trace linking).
    if (r.scores !== undefined) {
      await tx.score.deleteMany({ where: { resultId: result.id } });
      if (scoreRows.length > 0) {
        await tx.score.createMany({
          data: scoreRows.map((s) => ({ ...s, resultId: result.id })),
        });
      }
    }
    return result.id;
  });

  return NextResponse.json({ evaluation_result_id: resultId } satisfies UpsertResultResponse, {
    status: 200,
  });
}
