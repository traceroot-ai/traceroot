import { NextResponse } from "next/server";
import { prisma, CompleteRunRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ runId: string }> };

// POST /api/public/evaluation-runs/[runId]/complete — SDK marks a run
// completed/completed_with_errors/failed/incomplete with final counts.
// Completion is one-way and idempotent: a replay keeps the completion timestamp
// the first call stamped, and a finished run cannot be moved back to running.
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { runId } = await params;

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { id: true, status: true, completedAt: true, mainScoreName: true },
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

  // Resolve the run-level main-score name. Omitting `main_score_name` (every older
  // SDK) preserves the existing behavior: the name chosen at registration stands and
  // nothing here is validated. Only a non-null provided name engages resolution —
  // an explicit null is treated as "unspecified", never as clearing a chosen name.
  const providedName = c.main_score_name ?? undefined;
  let resolvedName: string | null | undefined; // undefined = don't write the column
  if (providedName !== undefined) {
    if (run.mainScoreName !== null && run.mainScoreName !== undefined) {
      // Registration already fixed the name — completion may only confirm it.
      if (providedName !== run.mainScoreName) {
        // Actionable conflict; the run is NOT mutated.
        return NextResponse.json(
          {
            error:
              `Run's main score name is already "${run.mainScoreName}" and cannot be ` +
              `changed to "${providedName}". Re-run with the registered name, or register ` +
              `a new run to use a different one.`,
          },
          { status: 409 },
        );
      }
      // Matches — idempotent, no column change needed.
    } else {
      // Registration omitted the name; completion resolves it now.
      resolvedName = providedName;
    }

    // For a successfully scored run, the resolved name must correspond to a real
    // emitted score (a scorer that errored still leaves a row under its name). A
    // failed/incomplete/cancelled run is exempt, so a run can always reach an honest
    // terminal state even when name resolution never happened.
    const SUCCESS_TERMINAL = new Set(["completed", "completed_with_errors"]);
    const effectiveName = resolvedName ?? run.mainScoreName ?? null;
    if (SUCCESS_TERMINAL.has(c.status) && effectiveName !== null) {
      const scoreRow = await prisma.score.findFirst({
        where: { scorerName: effectiveName, result: { runId } },
        select: { id: true },
      });
      if (!scoreRow) {
        return NextResponse.json(
          {
            error:
              `Main score name "${effectiveName}" was not found among this run's emitted ` +
              `scores. Complete as failed/incomplete, or report a score under that name.`,
          },
          { status: 400 },
        );
      }
    }
  }

  const updated = await prisma.evaluationRun.update({
    where: { id: runId },
    data: {
      status: c.status,
      ...(resolvedName !== undefined ? { mainScoreName: resolvedName } : {}),
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
      // Keep the first completion's timestamp: a retried /complete must not move
      // the run's recorded finish time (and with it its reported duration).
      ...(terminal ? { completedAt: run.completedAt ?? new Date() } : {}),
    },
    select: { id: true, status: true },
  });

  return NextResponse.json({ evaluation_run_id: updated.id, status: updated.status });
}
