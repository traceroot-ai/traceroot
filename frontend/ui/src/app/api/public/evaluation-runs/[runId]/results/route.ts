import { NextResponse } from "next/server";
import {
  prisma,
  Prisma,
  UpsertResultRequestSchema,
  type UpsertResultResponse,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string }> };

/**
 * A key the caller omitted contributes nothing to the update, so the stored value
 * survives; an explicit `null` still reaches the column and clears it.
 */
function setIfSent<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// POST /api/public/evaluation-runs/[runId]/results — SDK upserts one test-case
// result. Idempotent on (run_id, test_case_id) via uq_result_run_test_case, so a
// retried or concurrent report converges instead of racing. The call is a partial
// update: only the fields (and the `scores` array) the caller actually sent are
// written, so trace_id may be null now and set on a later minimal call without
// costing the result its cost or its scores.
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

  // First report of this test case: nothing is stored yet, so an absent field
  // really is null.
  const createFields = {
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
  // Follow-up report: it carries only what the caller knows at that moment. An
  // omitted key must not overwrite what an earlier call already established —
  // notably the trace link and the SDK-reported cost, which is authoritative.
  const updateFields = {
    input: r.input,
    status: r.status,
    ...setIfSent("expectedOutput", r.expected_output),
    ...setIfSent("candidateOutput", r.candidate_output),
    ...setIfSent("baselineOutput", r.baseline_output),
    ...setIfSent("mainScore", r.main_score),
    ...setIfSent("change", r.change),
    ...setIfSent("taskError", r.task_error),
    ...setIfSent("durationMs", r.duration_ms),
    ...setIfSent("cost", r.cost),
    ...setIfSent("traceId", r.trace_id),
  };
  // undefined when `scores` was absent — the scores are then left untouched.
  const scoreRows = r.scores?.map((s) => ({
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

  const upsertResult = () =>
    prisma.$transaction(async (tx) => {
      const result = await tx.evaluationResult.upsert({
        where: { runId_testCaseId: { runId, testCaseId: r.test_case_id } },
        create: {
          runId,
          evaluationId: run.evaluationId,
          projectId,
          testCaseId: r.test_case_id,
          ...createFields,
        },
        update: updateFields,
        select: { id: true },
      });
      if (scoreRows) {
        await tx.score.deleteMany({ where: { resultId: result.id } });
        if (scoreRows.length > 0) {
          await tx.score.createMany({
            data: scoreRows.map((s) => ({ ...s, resultId: result.id })),
          });
        }
      }
      return result.id;
    });

  let resultId: string;
  try {
    resultId = await upsertResult();
  } catch (e) {
    // Two in-flight reports of the same test case (the SDK retries a request it
    // never saw the response to): the loser lost the insert race, and on a second
    // pass the row exists and it takes the update path.
    if (!isUniqueViolation(e)) {
      return NextResponse.json({ error: "Failed to record result" }, { status: 500 });
    }
    try {
      resultId = await upsertResult();
    } catch {
      return NextResponse.json({ error: "Failed to record result" }, { status: 500 });
    }
  }

  return NextResponse.json({ evaluation_result_id: resultId } satisfies UpsertResultResponse, {
    status: 200,
  });
}
