import { NextResponse } from "next/server";
import { prisma, CompleteRunRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string }> };

// POST /api/public/evaluation-runs/[runId]/complete — SDK marks a run
// completed/completed_with_errors/failed/incomplete with final counts.
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { runId } = await params;

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { id: true },
  });
  if (!run) return NextResponse.json({ error: "Evaluation run not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CompleteRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const c = parsed.data;

  const terminal = c.status !== "running";
  const updated = await prisma.evaluationRun.update({
    where: { id: runId },
    data: {
      status: c.status,
      ...(c.main_score !== undefined ? { mainScore: c.main_score } : {}),
      ...(c.case_count !== undefined && c.case_count !== null ? { caseCount: c.case_count } : {}),
      ...(c.scored_count !== undefined && c.scored_count !== null
        ? { scoredCount: c.scored_count }
        : {}),
      ...(c.task_error_count !== undefined && c.task_error_count !== null
        ? { taskErrorCount: c.task_error_count }
        : {}),
      ...(c.scorer_error_count !== undefined && c.scorer_error_count !== null
        ? { scorerErrorCount: c.scorer_error_count }
        : {}),
      ...(terminal ? { completedAt: new Date() } : {}),
    },
    select: { id: true, status: true },
  });

  return NextResponse.json({ evaluation_run_id: updated.id, status: updated.status });
}
