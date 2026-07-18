import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { compareRuns } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults } from "@/lib/eval/comparison-db";
import { countResultStatuses, passRate, excludedSummary } from "@/lib/eval/pass-rate";

type RouteParams = { params: Promise<{ projectId: string }> };

/**
 * Run duration, derived rather than stored. A finished run is wall-clock
 * started → completed. A run still in flight has no completion time, so it falls
 * back to the span of its cases' durations — returning null there would blank the
 * duration column on exactly the rows someone is watching tick upward.
 */
function elapsedMs(
  startedAt: Date,
  completedAt: Date | null,
  caseDurationMs: number | null,
): number | null {
  if (completedAt) {
    const ms = completedAt.getTime() - startedAt.getTime();
    if (ms >= 0) return ms;
  }
  return caseDurationMs;
}

/** Sum the non-null members, or null when there are none — never a misleading 0. */
function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

// Whitelist for `sort` — never let a raw query-string value reach `orderBy` or
// an object-key lookup. Anything outside this set (or absent) falls back to
// the default, it never errors.
const SORT_FIELDS = ["startedAt", "mainScore", "cost", "elapsedMs", "status"] as const;
type SortField = (typeof SORT_FIELDS)[number];
const DEFAULT_SORT: SortField = "startedAt";

function parseSort(value: string | null): SortField {
  return (SORT_FIELDS as readonly string[]).includes(value ?? "")
    ? (value as SortField)
    : DEFAULT_SORT;
}

function parseOrder(value: string | null): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

/** A valid `Date`, or null for anything missing/unparseable — a bad bound is
 * dropped rather than surfaced as an error, matching `limit`/`page` above. */
function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// startedAt/mainScore/status are real columns — sort + paginate in the DB.
// cost/elapsedMs are derived (a per-run cost aggregate and a completedAt -
// startedAt difference), so they're computed and sorted over the FULL
// filtered set here on the server, then sliced to the requested page. That
// keeps ordering correct across pages — never just a reorder of the page
// that would already have been fetched.
const DB_SORTABLE = new Set<SortField>(["startedAt", "mainScore", "status"]);

// GET — evaluation runs (executions) for the project. Filters: evaluation_id,
// dataset_id, status, search_query, started_after, started_before. Sort:
// sort/order over startedAt|mainScore|cost|elapsedMs|status.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const page = isNaN(rawPage) ? 0 : Math.max(rawPage, 0);
  const evaluationId = searchParams.get("evaluation_id")?.trim() || null;
  const datasetId = searchParams.get("dataset_id")?.trim() || null;
  const status = searchParams.get("status")?.trim() || null;
  const searchQuery = searchParams.get("search_query")?.trim() || null;
  const sort = parseSort(searchParams.get("sort"));
  const order = parseOrder(searchParams.get("order"));
  const startedAfter = parseDateParam(searchParams.get("started_after"));
  const startedBefore = parseDateParam(searchParams.get("started_before"));

  const where = {
    projectId,
    ...(evaluationId ? { evaluationId } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(status ? { status } : {}),
    ...(searchQuery
      ? {
          OR: [
            { candidateVersion: { contains: searchQuery, mode: "insensitive" as const } },
            { evaluation: { name: { contains: searchQuery, mode: "insensitive" as const } } },
          ],
        }
      : {}),
    ...(startedAfter || startedBefore
      ? {
          startedAt: {
            ...(startedAfter ? { gte: startedAfter } : {}),
            ...(startedBefore ? { lte: startedBefore } : {}),
          },
        }
      : {}),
  };

  const include = {
    evaluation: { select: { name: true } },
    datasetVersion: { select: { label: true } },
  };

  let runs: Awaited<ReturnType<typeof prisma.evaluationRun.findMany<{ include: typeof include }>>>;
  let total: number;

  if (DB_SORTABLE.has(sort)) {
    [runs, total] = await prisma.$transaction([
      prisma.evaluationRun.findMany({
        where,
        orderBy: { [sort]: order },
        skip: page * limit,
        take: limit,
        include,
      }),
      prisma.evaluationRun.count({ where }),
    ]);
  } else {
    const all = await prisma.evaluationRun.findMany({ where, include });
    total = all.length;

    let sortValue: (r: (typeof all)[number]) => number | null;
    if (sort === "elapsedMs") {
      sortValue = (r) => elapsedMs(r.startedAt, r.completedAt);
    } else {
      const ids = all.map((r) => r.id);
      const costSums =
        ids.length > 0
          ? await prisma.evaluationResult.groupBy({
              by: ["runId"],
              where: { runId: { in: ids }, projectId, cost: { not: null } },
              _sum: { cost: true },
            })
          : [];
      const costByRun = new Map(costSums.map((c) => [c.runId, c._sum.cost]));
      sortValue = (r) => costByRun.get(r.id) ?? null;
    }

    const dir = order === "asc" ? 1 : -1;
    all.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      // Unknown (still running / no cost reported) always sorts last, in
      // either direction — never a misleading position for missing data.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });

    runs = all.slice(page * limit, page * limit + limit);
  }

  const datasetIds = [...new Set(runs.map((r) => r.datasetId))];
  const datasets =
    datasetIds.length > 0
      ? await prisma.dataset.findMany({
          where: { id: { in: datasetIds }, projectId },
          select: { id: true, name: true },
        })
      : [];
  const datasetName = new Map(datasets.map((d) => [d.id, d.name]));

  // Status counts, cost and case-duration totals are aggregated IN the database: one
  // grouped query returns a handful of rows for the whole page. Folding them in Node
  // instead would pull every result row for every listed run — including four
  // unbounded TEXT columns (input/expected/candidate/baseline output) none of these
  // derivations read — to produce four integers and two sums per row.
  const pageRunIds = runs.map((r) => r.id);
  const resultGroups =
    pageRunIds.length > 0
      ? await prisma.evaluationResult.groupBy({
          by: ["runId", "status"],
          where: { runId: { in: pageRunIds }, projectId },
          _count: { _all: true },
          _sum: { cost: true, durationMs: true },
        })
      : [];
  const groupsByRun = new Map<string, typeof resultGroups>();
  for (const g of resultGroups) {
    const list = groupsByRun.get(g.runId);
    if (list) list.push(g);
    else groupsByRun.set(g.runId, [g]);
  }

  // Restrained per-run comparison summary from the SAME engine as run detail. This is
  // the one derivation that genuinely needs per-case rows, so it is narrowed twice:
  // to the runs that actually declare a baseline (plus those baselines), and to the
  // columns the engine reads. Still batched — a bounded number of queries per page,
  // never a per-row N+1.
  const baselineIds = [
    ...new Set(runs.map((r) => r.baselineRunId).filter((x): x is string => !!x)),
  ];
  const baselineRuns =
    baselineIds.length > 0
      ? await prisma.evaluationRun.findMany({
          where: { id: { in: baselineIds }, projectId },
          select: {
            id: true,
            runNumber: true,
            evaluationId: true,
            datasetVersionId: true,
            candidateVersion: true,
            status: true,
            mainScore: true,
            mainScoreName: true,
            baselineRunId: true,
            scorers: true,
          },
        })
      : [];
  const baselineById = new Map(baselineRuns.map((b) => [b.id, b]));

  const comparedRunIds = runs.filter((r) => r.baselineRunId).map((r) => r.id);
  const resultRunIds = [...new Set([...comparedRunIds, ...baselineIds])];
  const allResults =
    resultRunIds.length > 0
      ? await prisma.evaluationResult.findMany({
          where: { runId: { in: resultRunIds }, projectId },
          select: {
            runId: true,
            testCaseId: true,
            status: true,
            mainScore: true,
            candidateOutput: true,
            durationMs: true,
            scores: {
              select: {
                scorerName: true,
                scorerVersion: true,
                numericValue: true,
                boolValue: true,
                stringValue: true,
                error: true,
              },
            },
          },
        })
      : [];
  const resultsByRun = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const list = resultsByRun.get(r.runId);
    if (list) list.push(r);
    else resultsByRun.set(r.runId, [r]);
  }

  const data = runs.map((r) => {
    const baseline = r.baselineRunId ? (baselineById.get(r.baselineRunId) ?? null) : null;
    const { comparison } = compareRuns({
      candidate: toComparisonRun(r),
      candidateResults: toComparisonResults(resultsByRun.get(r.id) ?? []),
      baseline: baseline ? toComparisonRun(baseline) : null,
      baselineResults: baseline ? toComparisonResults(resultsByRun.get(baseline.id) ?? []) : [],
    });
    const groups = groupsByRun.get(r.id) ?? [];
    const statusCounts = countResultStatuses(
      groups.map((g) => ({ status: g.status, count: g._count._all })),
    );
    // Total cost across the run's cases (SDK-reported per result). Null when no case
    // reported a cost — never a misleading 0.
    const cost = sumOrNull(groups.map((g) => g._sum.cost));
    const caseDurationMs = sumOrNull(groups.map((g) => g._sum.durationMs));
    return {
      ...r,
      evaluationName: r.evaluation.name,
      datasetName: datasetName.get(r.datasetId) ?? null,
      datasetVersionLabel: r.datasetVersion.label,
      cost,
      // Delta + regressed-case count only when trustworthy; otherwise null (UI shows —),
      // never a misleading number beside an incompatible baseline.
      changeFromBaseline: comparison.trustworthy ? comparison.mainScore.delta : null,
      regressedCaseCount: comparison.trustworthy ? comparison.caseCounts.regressed : null,
      baselineComparable: comparison.trustworthy,
      errorCount: r.taskErrorCount + r.scorerErrorCount,
      elapsedMs: elapsedMs(r.startedAt, r.completedAt, caseDurationMs),
      ...statusCounts,
      // Served, not left to each consumer: passed / (passed + failed), null when
      // nothing was judged. A client recomputing it would divide by zero and render
      // an all-errored run as a catastrophic-looking 0%.
      passRate: passRate(statusCounts.passedCount, statusCounts.failedCount),
      excludedSummary: excludedSummary(statusCounts.erroredCount, statusCounts.notScoredCount),
    };
  });

  return successResponse({ data, meta: { page, limit, total } });
}
