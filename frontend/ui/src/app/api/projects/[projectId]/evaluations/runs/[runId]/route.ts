import { NextRequest } from "next/server";
import { prisma, PlanType, Role } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isOutsideRetention } from "@/lib/server/retention";
import { compareRuns } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults } from "@/lib/eval/comparison-db";
import { countResultStatuses } from "@/lib/eval/result-status-counts";

type RouteParams = { params: Promise<{ projectId: string; runId: string }> };

// A run's (and its baseline's) result set is unbounded in principle — a large run can
// have thousands of cases, each carrying several @db.Text columns plus per-scorer rows.
// Capping keeps a single request's query size and response payload bounded; `resultsTruncated`
// tells the caller when they are looking at a partial view. This is a stopgap, not real
// pagination; a fuller approach would page `results` while keeping the aggregate
// `comparison` computed over the full set.
const MAX_RUN_DETAIL_RESULTS = 1000;

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
        },
      },
    },
  });
  if (!run) return errorResponse("Evaluation run not found", 404);

  // Retention gate — the by-id half. A list has a window to pull forward, so it clamps
  // silently; a by-id read has none, so it refuses. That is the split the telemetry
  // surfaces already make between clamp_retention_window and enforce_retention_by_time
  // (backend/rest/retention.py), and `isOutsideRetention` is the second of those for the
  // Node routes. Plan resolution matches the detector proxies: an unreadable or absent
  // workspace fails closed to the most restrictive plan.
  //
  // This also gates the comparison page, which has no route of its own — it fetches each
  // selected run through here, so an out-of-window run cannot be smuggled in as a
  // comparison column either.
  //
  // Placed after the 404 so a run that does not exist stays a 404 (and skips the plan
  // lookup), and before the baseline/dataset/aggregate reads so a refusal does no work.
  // A run's embedded baseline is not separately gated: it is reachable only as the diff
  // columns of an in-window run, which is how a run's baseline is surfaced elsewhere too.
  const workspace = await prisma.workspace.findUnique({
    where: { id: accessResult.project.workspaceId },
    select: { billingPlan: true },
  });
  const billingPlan = workspace?.billingPlan || PlanType.FREE;
  if (isOutsideRetention(billingPlan, run.startedAt)) {
    return errorResponse("Data outside retention window", 403);
  }

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
      // Metric-first: no single per-case improved/regressed verdict.
      change: null,
      baselineOutput: cmp ? cmp.baselineOutput : null,
      // Without a baseline, every case's comparison would be the same "candidate_only,
      // all cells unpaired" object — zero information, so omit it rather than inflate
      // the common (no-baseline) case's payload.
      comparison:
        cmp && baselineRun
          ? {
              pairing: cmp.pairing,
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

  // Run totals derived from ALL results (never the capped `results` page above): the
  // summed per-case duration AND cost. The runs list sums the same way, so the detail
  // and the list agree; there is no trustworthy stored run-level cost/duration to read
  // instead — cost lives per case, so the headline stat must sum it here.
  const resultAgg = await prisma.evaluationResult.aggregate({
    where: { runId, projectId },
    _sum: { durationMs: true, cost: true },
  });

  const { results: _omit, ...runFields } = run;
  return successResponse({
    run: {
      ...runFields,
      evaluationName: run.evaluation.name,
      datasetName: dataset?.name ?? null,
      datasetVersionLabel: run.datasetVersion.label,
      // Metric-first: no single headline delta from a baseline (per-metric deltas live in
      // the comparison block); kept null for back-compat with the run read model.
      changeFromBaseline: null,
      baselineComparable: comparison.trustworthy,
      errorCount: run.taskErrorCount + run.scorerErrorCount,
      elapsedMs: resultAgg._sum.durationMs,
      // Summed per-case cost — the runs list computes it the same way. Overrides any
      // stored run.cost (there is none), so the headline stat matches the case rows.
      cost: resultAgg._sum.cost,
      ...countResultStatuses(statusGroups.map((g) => ({ status: g.status, count: g._count._all }))),
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
