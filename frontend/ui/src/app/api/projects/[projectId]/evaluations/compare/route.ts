import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { compareRuns } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults, caseChangeToLegacy } from "@/lib/eval/comparison-db";

type RouteParams = { params: Promise<{ projectId: string }> };

function elapsedMs(startedAt: Date, completedAt: Date | null): number | null {
  if (!completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  return ms >= 0 ? ms : null;
}

const runInclude = {
  evaluation: { select: { name: true } },
  datasetVersion: { select: { label: true } },
  results: {
    orderBy: { createTime: "asc" as const },
    include: { scores: { orderBy: { createTime: "asc" as const } } },
  },
};

function runSummary(run: Awaited<ReturnType<typeof loadRun>>) {
  if (!run) return null;
  return {
    id: run.id,
    runNumber: run.runNumber,
    evaluationId: run.evaluationId,
    evaluationName: run.evaluation.name,
    candidateVersion: run.candidateVersion,
    datasetVersionId: run.datasetVersionId,
    datasetVersionLabel: run.datasetVersion.label,
    status: run.status,
    mainScore: run.mainScore,
    mainScoreName: run.mainScoreName,
    caseCount: run.caseCount,
    scoredCount: run.scoredCount,
    taskErrorCount: run.taskErrorCount,
    scorerErrorCount: run.scorerErrorCount,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs: elapsedMs(run.startedAt, run.completedAt),
  };
}

function loadRun(projectId: string, runId: string) {
  return prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    include: runInclude,
  });
}

// GET — compare two arbitrary runs (candidate vs baseline) of the same evaluation.
// Reuses the same derivation as the run-detail route (compareRuns over the two
// runs' raw results/scores), but lets the caller choose both sides rather than
// relying on the stored baselineRunId. `?candidate=<runId>&baseline=<runId>`.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const candidateId = req.nextUrl.searchParams.get("candidate");
  const baselineId = req.nextUrl.searchParams.get("baseline");
  if (!candidateId || !baselineId) {
    return errorResponse("Both candidate and baseline run ids are required", 400);
  }
  if (candidateId === baselineId) {
    return errorResponse("Pick two different runs to compare", 400);
  }

  const [candidate, baseline] = await Promise.all([
    loadRun(projectId, candidateId),
    loadRun(projectId, baselineId),
  ]);
  if (!candidate) return errorResponse("Candidate run not found", 404);
  if (!baseline) return errorResponse("Baseline run not found", 404);

  const { comparison, results: resultComparisons } = compareRuns({
    candidate: toComparisonRun(candidate),
    candidateResults: toComparisonResults(candidate.results),
    baseline: toComparisonRun(baseline),
    baselineResults: toComparisonResults(baseline.results),
  });

  const cmpByCase = new Map(resultComparisons.map((c) => [c.testCaseId, c]));
  const baselineTraceByCase = new Map(baseline.results.map((r) => [r.testCaseId, r.traceId]));

  const results = candidate.results.map((r) => {
    const cmp = cmpByCase.get(r.testCaseId);
    return {
      testCaseId: r.testCaseId,
      status: r.status,
      traceId: r.traceId,
      candidateOutput: r.candidateOutput,
      change: cmp ? caseChangeToLegacy(cmp.caseChange) : null,
      comparison: cmp
        ? {
            caseChange: cmp.caseChange,
            pairing: cmp.pairing,
            mainScore: cmp.mainScore,
            baselineOutput: cmp.baselineOutput,
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

  // Baseline-only cases (present in baseline, absent from candidate) so the table
  // can show them as dropped rather than silently omitting them.
  const candidateCaseIds = new Set(candidate.results.map((r) => r.testCaseId));
  const baselineOnly = resultComparisons
    .filter((c) => c.pairing === "baseline_only" && !candidateCaseIds.has(c.testCaseId))
    .map((c) => ({
      testCaseId: c.testCaseId,
      status: c.status,
      traceId: null,
      candidateOutput: null,
      change: caseChangeToLegacy(c.caseChange),
      comparison: {
        caseChange: c.caseChange,
        pairing: c.pairing,
        mainScore: c.mainScore,
        baselineOutput: c.baselineOutput,
        baselineDurationMs: c.baselineDurationMs,
        durationDeltaMs: c.durationDeltaMs,
        baselineTraceId: baselineTraceByCase.get(c.testCaseId) ?? null,
        scorerCells: c.scorerCells,
        regressedCellCount: c.regressedCellCount,
        comparableCellCount: c.comparableCellCount,
      },
    }));

  return successResponse({
    candidate: runSummary(candidate),
    baseline: runSummary(baseline),
    comparison,
    results: [...results, ...baselineOnly],
  });
}
