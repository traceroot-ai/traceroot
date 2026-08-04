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
import { deriveHumanReviewSummary, type HumanVerdict } from "@/lib/eval/human-review";

type RouteParams = { params: Promise<{ projectId: string; runId: string }> };

// A run's (and its baseline's) result set is unbounded in principle — a large run can
// have thousands of cases, each carrying several @db.Text columns plus per-scorer rows.
// Capping keeps a single request's query size and response payload bounded; `resultsTruncated`
// tells the caller when they are looking at a partial view. This is a stopgap, not real
// pagination; a fuller approach would page `results` while keeping the aggregate
// `comparison` computed over the full set.
const MAX_RUN_DETAIL_RESULTS = 1000;

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
        take: MAX_RUN_DETAIL_RESULTS,
        include: {
          scores: { orderBy: { createTime: "asc" } },
          humanScores: { orderBy: { createTime: "desc" } },
        },
      },
    },
  });
  if (!run) return errorResponse("Evaluation run not found", 404);

  // The baseline's raw results + scores (no per-row N+1), capped the same way.
  const baselineRun = run.baselineRunId
    ? await prisma.evaluationRun.findFirst({
        where: { id: run.baselineRunId, projectId },
        include: { results: { take: MAX_RUN_DETAIL_RESULTS, include: { scores: true } } },
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
      // Without a baseline, every case's comparison would be the same "candidate_only,
      // all cells unpaired" object — zero information, so omit it rather than inflate
      // the common (no-baseline) case's payload.
      comparison:
        cmp && baselineRun
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

  // Run-wide status counts from a grouped aggregate — NOT the capped `results` page,
  // which would under-count pass/fail/errored for a run over MAX_RUN_DETAIL_RESULTS.
  // `resultsTruncated` below still flags that the detail table + derived comparison are
  // a partial view of a very large run.
  const statusGroups = await prisma.evaluationResult.groupBy({
    by: ["status"],
    where: { runId, projectId },
    _count: { _all: true },
  });

  // Derived human-review summary: reviewed/pending over active dimensions, human
  // pass/fail, and human-vs-automated disagreement. Read-only — computing this never
  // touches the automated score, comparison, or run status.
  const humanReview = deriveHumanReviewSummary(
    run.results.map((r) => ({
      automatedPass: r.status === "passed" ? true : r.status === "failed" ? false : null,
      reviews: r.humanScores.map((h) => ({
        dimension: h.dimension,
        verdict: h.verdict as HumanVerdict,
      })),
    })),
  );

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
      ...countResultStatuses(statusGroups.map((g) => ({ status: g.status, count: g._count._all }))),
      humanReview,
      comparison,
      // True when `results` (and the comparison derived from it) is a partial view —
      // the run has more cases than the cap above.
      resultsTruncated: run.caseCount > run.results.length,
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
