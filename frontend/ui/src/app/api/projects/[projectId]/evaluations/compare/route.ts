import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { compareRuns, type ResultComparison } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults, caseChangeToLegacy } from "@/lib/eval/comparison-db";

type RouteParams = { params: Promise<{ projectId: string }> };

function elapsedMs(startedAt: Date, completedAt: Date | null): number | null {
  if (!completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  return ms >= 0 ? ms : null;
}

// Both runs' result sets are unbounded in principle — a large run can have thousands
// of cases, each carrying several @db.Text columns plus per-scorer rows. Capping keeps
// the query size and response payload bounded; `resultsTruncated` in the response tells
// the caller when they are looking at a partial comparison.
const MAX_COMPARE_RESULTS = 1000;

const runInclude = {
  evaluation: { select: { name: true } },
  datasetVersion: { select: { label: true } },
  results: {
    orderBy: { createTime: "asc" as const },
    take: MAX_COMPARE_RESULTS,
    include: { scores: { orderBy: { createTime: "asc" as const } } },
  },
};

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;
type ResultRow = LoadedRun["results"][number];
type ScoreRow = ResultRow["scores"][number];

function runSummary(run: LoadedRun) {
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

/** Raw per-scorer values (incl. explanation) for the case drawer's score breakdown. */
function trimScore(s: ScoreRow) {
  return {
    scorerName: s.scorerName,
    scorerVersion: s.scorerVersion,
    numericValue: s.numericValue,
    boolValue: s.boolValue,
    stringValue: s.stringValue,
    passed: s.passed,
    explanation: s.explanation,
    error: s.error,
  };
}

/** Two outputs "changed" when both exist and differ, or exactly one exists. Null when
 *  neither side has an output (nothing to compare). */
function outputChanged(candidate: string | null, baseline: string | null): boolean | null {
  if (candidate === null && baseline === null) return null;
  return candidate !== baseline;
}

interface CanonicalCase {
  input: string;
  expectedOutput: string | null;
  metadata: unknown;
  provenance: {
    sourceTraceId: string | null;
    sourceSpanName: string | null;
    sourceSpanKind: string | null;
    captureReason: string;
  } | null;
}

// GET — compare two runs (candidate vs baseline). Reuses the same derivation as the
// run-detail route (compareRuns over both runs' raw results/scores) and surfaces the
// read fields the comparison page needs: canonical dataset input/expected/metadata +
// provenance (from the candidate run's PINNED dataset version), both sides' output/
// status/cost/task-error, candidate + baseline trace ids, per-scorer comparisons +
// raw explanations, duration, and an output-changed flag. All comparison MATH stays in
// the pure engine; this route only assembles already-fetched rows (no N+1).
// `?candidate=<runId>&baseline=<runId>`.
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

  // Canonical case content from the candidate run's PINNED dataset version (one query,
  // no N+1) — the input/expected the engineer authored, not a per-run copy. If a run
  // recorded a different input, we prefer the canonical and flag the discrepancy. Scoped
  // to the test cases actually referenced by the (capped) result sets above, rather than
  // the entire pinned dataset version — a shared dataset can far outgrow one run's cases.
  const referencedCaseIds = [
    ...new Set([...candidate.results, ...baseline.results].map((r) => r.testCaseId)),
  ];
  const canonicalRows = await prisma.testCase.findMany({
    where: {
      datasetVersionId: candidate.datasetVersionId,
      projectId,
      testCaseId: { in: referencedCaseIds },
    },
    select: {
      testCaseId: true,
      input: true,
      expected: true,
      metadata: true,
      sourceTraceId: true,
      sourceSpanName: true,
      sourceSpanKind: true,
      captureReason: true,
    },
  });
  const canonicalByCase = new Map<string, CanonicalCase>(
    canonicalRows.map((t) => [
      t.testCaseId,
      {
        input: t.input,
        expectedOutput: t.expected,
        metadata: t.metadata,
        provenance: t.sourceTraceId
          ? {
              sourceTraceId: t.sourceTraceId,
              sourceSpanName: t.sourceSpanName,
              sourceSpanKind: t.sourceSpanKind,
              captureReason: t.captureReason,
            }
          : null,
      },
    ]),
  );

  const cmpByCase = new Map(resultComparisons.map((c) => [c.testCaseId, c]));
  const candByCase = new Map(candidate.results.map((r) => [r.testCaseId, r]));
  const baseByCase = new Map(baseline.results.map((r) => [r.testCaseId, r]));

  const buildCase = (testCaseId: string, cmp: ResultComparison | undefined) => {
    const cand = candByCase.get(testCaseId) ?? null;
    const base = baseByCase.get(testCaseId) ?? null;
    const canonical = canonicalByCase.get(testCaseId) ?? null;
    const candidateOutput = cand?.candidateOutput ?? null;
    const baselineOutput = cmp?.baselineOutput ?? base?.candidateOutput ?? null;
    // Canonical input, falling back to whatever a run recorded when the case isn't in
    // the candidate's pinned version (e.g. a baseline-only case from another version).
    const input = canonical?.input ?? cand?.input ?? base?.input ?? "";
    const recordedInput = cand?.input ?? base?.input ?? null;
    return {
      testCaseId,
      input,
      expectedOutput: canonical?.expectedOutput ?? cand?.expectedOutput ?? null,
      metadata: canonical?.metadata ?? null,
      provenance: canonical?.provenance ?? null,
      // True when a run's recorded input diverges from the pinned dataset case.
      inputMatchesDataset: canonical ? recordedInput === null || recordedInput === input : true,
      candidateStatus: cand?.status ?? null,
      baselineStatus: base?.status ?? null,
      candidateOutput,
      baselineOutput,
      candidateTraceId: cand?.traceId ?? null,
      baselineTraceId: base?.traceId ?? null,
      candidateCost: cand?.cost ?? null,
      baselineCost: base?.cost ?? null,
      candidateTaskError: cand?.taskError ?? null,
      baselineTaskError: base?.taskError ?? null,
      candidateScores: (cand?.scores ?? []).map(trimScore),
      baselineScores: (base?.scores ?? []).map(trimScore),
      outputChanged: outputChanged(candidateOutput, baselineOutput),
      change: cmp ? caseChangeToLegacy(cmp.caseChange) : null,
      comparison: cmp
        ? {
            caseChange: cmp.caseChange,
            pairing: cmp.pairing,
            mainScore: cmp.mainScore,
            baselineOutput: cmp.baselineOutput,
            durationMs: cmp.durationMs,
            baselineDurationMs: cmp.baselineDurationMs,
            durationDeltaMs: cmp.durationDeltaMs,
            baselineTraceId: base?.traceId ?? null,
            scorerCells: cmp.scorerCells,
            regressedCellCount: cmp.regressedCellCount,
            comparableCellCount: cmp.comparableCellCount,
          }
        : null,
    };
  };

  // Candidate-side cases in their reported order, then baseline-only (dropped) cases so
  // the table shows them rather than silently omitting them.
  const results = candidate.results.map((r) =>
    buildCase(r.testCaseId, cmpByCase.get(r.testCaseId)),
  );
  const candidateCaseIds = new Set(candidate.results.map((r) => r.testCaseId));
  const baselineOnly = resultComparisons
    .filter((c) => c.pairing === "baseline_only" && !candidateCaseIds.has(c.testCaseId))
    .map((c) => buildCase(c.testCaseId, c));

  return successResponse({
    candidate: runSummary(candidate),
    baseline: runSummary(baseline),
    comparison,
    results: [...results, ...baselineOnly],
    // True when either side has more cases than the cap above — the comparison and
    // `results` are a partial view.
    resultsTruncated:
      candidate.caseCount > candidate.results.length ||
      baseline.caseCount > baseline.results.length,
  });
}
