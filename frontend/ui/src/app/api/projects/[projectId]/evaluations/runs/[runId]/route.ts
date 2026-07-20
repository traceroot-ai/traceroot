import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { compareRuns } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults, caseChangeToLegacy } from "@/lib/eval/comparison-db";
import { countResultStatuses } from "@/lib/eval/pass-rate";

type RouteParams = { params: Promise<{ projectId: string; runId: string }> };

function elapsedMs(startedAt: Date, completedAt: Date | null): number | null {
  if (!completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  return ms >= 0 ? ms : null;
}

// GET — a single evaluation run with its results, scores, human scores, and the
// backend-derived candidate-vs-baseline comparison (the single source of truth).
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, runId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    include: {
      evaluation: { select: { name: true } },
      datasetVersion: { select: { label: true } },
      baselineRun: {
        select: {
          id: true,
          runNumber: true,
          candidateVersion: true,
          mainScore: true,
          evaluationId: true,
          datasetVersionId: true,
          datasetVersion: { select: { label: true } },
        },
      },
      results: {
        orderBy: { createTime: "asc" },
        include: {
          scores: { orderBy: { createTime: "asc" } },
          humanScores: { orderBy: { createTime: "desc" } },
        },
      },
    },
  });
  if (!run) return errorResponse("Evaluation run not found", 404);

  // The baseline's raw results + scores, in one bounded query (no per-row N+1).
  const baselineRun = run.baselineRunId
    ? await prisma.evaluationRun.findFirst({
        where: { id: run.baselineRunId, projectId },
        include: { results: { include: { scores: true } } },
      })
    : null;

  const dataset = await prisma.dataset.findFirst({
    where: { id: run.datasetId, projectId },
    select: { id: true, name: true },
  });

  // Derive the comparison from the two runs' raw results/scores — never the stored
  // change/baselineOutput columns.
  const { comparison, results: resultComparisons } = compareRuns({
    candidate: toComparisonRun(run),
    candidateResults: toComparisonResults(run.results),
    baseline: baselineRun ? toComparisonRun(baselineRun) : null,
    baselineResults: baselineRun ? toComparisonResults(baselineRun.results) : [],
  });
  const cmpByCase = new Map(resultComparisons.map((c) => [c.testCaseId, c]));
  // The baseline case's trace id, so the UI can fetch it to diff tokens/cost/latency.
  const baselineTraceByCase = new Map(
    (baselineRun?.results ?? []).map((r) => [r.testCaseId, r.traceId]),
  );

  const results = run.results.map((r) => {
    const cmp = cmpByCase.get(r.testCaseId);
    return {
      ...r,
      // Derived values win over the stored columns.
      change: cmp ? caseChangeToLegacy(cmp.caseChange) : null,
      baselineOutput: cmp ? cmp.baselineOutput : null,
      comparison: cmp
        ? {
            caseChange: cmp.caseChange,
            pairing: cmp.pairing,
            mainScore: cmp.mainScore,
            baselineDurationMs: cmp.baselineDurationMs,
            durationDeltaMs: cmp.durationDeltaMs,
            baselineTraceId: baselineTraceByCase.get(r.testCaseId) ?? null,
            scorerCells: cmp.scorerCells,
            regressedCellCount: cmp.regressedCellCount,
            comparableCellCount: cmp.comparableCellCount,
          }
        : null,
    };
  });

  const { results: _omit, ...runFields } = run;
  return successResponse({
    run: {
      ...runFields,
      evaluationName: run.evaluation.name,
      datasetName: dataset?.name ?? null,
      datasetVersionLabel: run.datasetVersion.label,
      // Back-compat run-level fields, now sourced from the derived comparison. The scalar
      // delta stays null unless the comparison is trustworthy, so the UI never subtracts
      // incompatible numbers; the richer `comparison` block carries the raw delta + trust.
      changeFromBaseline: comparison.trustworthy ? comparison.mainScore.delta : null,
      baselineComparable: comparison.trustworthy,
      errorCount: run.taskErrorCount + run.scorerErrorCount,
      elapsedMs: elapsedMs(run.startedAt, run.completedAt),
      ...countResultStatuses(run.results),
      comparison,
    },
    results,
  });
}

// DELETE — remove a run (cascades its results + scores; other runs that used it as
// a baseline have their baselineRunId set to null). Editing access required.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, runId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  const existing = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { id: true },
  });
  if (!existing) return errorResponse("Evaluation run not found", 404);

  await prisma.evaluationRun.delete({ where: { id: runId } });
  return successResponse({ deleted: true });
}
