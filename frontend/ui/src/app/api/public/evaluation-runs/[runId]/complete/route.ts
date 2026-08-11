import { NextResponse } from "next/server";
import { prisma, CompleteRunRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string }> };

// POST /api/public/evaluation-runs/[runId]/complete — SDK marks a run
// completed/completed_with_errors/failed/incomplete with final counts.
//
// Metric-first: a run has no single headline score and no run-level pass/fail, so
// completion neither resolves a headline-metric name nor reconciles per-case pass/fail. Each
// case's terminal status is what the SDK reported through the results endpoint; completion
// only fixes the run's status + counts.
//
// Completion is one-way and idempotent: a replay keeps the completion timestamp the first
// call stamped, and a finished run cannot be moved back to running.
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { runId } = await params;

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { id: true, status: true, completedAt: true },
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
  // A finished run stays finished. Accepting "running" here would leave status
  // and completedAt describing different things for the same row, so readers
  // filtering on status disagree with readers filtering on completedAt IS NULL.
  if (!terminal && run.status !== "running") {
    return NextResponse.json(
      { error: `Run is already ${run.status} and cannot be reopened` },
      { status: 409 },
    );
  }

  const updated = await prisma.evaluationRun.update({
    where: { id: runId },
    data: {
      status: c.status,
      ...(c.case_count != null ? { caseCount: c.case_count } : {}),
      ...(c.scored_count != null ? { scoredCount: c.scored_count } : {}),
      ...(c.task_error_count != null ? { taskErrorCount: c.task_error_count } : {}),
      ...(c.scorer_error_count != null ? { scorerErrorCount: c.scorer_error_count } : {}),
      // Keep the first completion's timestamp: a retried /complete must not move
      // the run's recorded finish time (and with it its reported duration).
      ...(terminal ? { completedAt: run.completedAt ?? new Date() } : {}),
    },
    select: { id: true, status: true },
  });

  return NextResponse.json({ evaluation_run_id: updated.id, status: updated.status });
}
