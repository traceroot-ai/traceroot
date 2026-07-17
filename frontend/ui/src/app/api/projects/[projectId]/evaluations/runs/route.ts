import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { compareRuns } from "@/lib/eval/comparison";
import { toComparisonRun, toComparisonResults } from "@/lib/eval/comparison-db";
import { countResultStatuses } from "@/lib/eval/pass-rate";

type RouteParams = { params: Promise<{ projectId: string }> };

function elapsedMs(startedAt: Date, completedAt: Date | null): number | null {
  if (!completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  return ms >= 0 ? ms : null;
}

// GET — evaluation runs (executions) for the project. Filters: evaluation_id,
// dataset_id, status, search_query.
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
  };

  const [runs, total] = await prisma.$transaction([
    prisma.evaluationRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: page * limit,
      take: limit,
      include: {
        evaluation: { select: { name: true } },
        datasetVersion: { select: { label: true } },
      },
    }),
    prisma.evaluationRun.count({ where }),
  ]);

  const datasetIds = [...new Set(runs.map((r) => r.datasetId))];
  const datasets =
    datasetIds.length > 0
      ? await prisma.dataset.findMany({
          where: { id: { in: datasetIds }, projectId },
          select: { id: true, name: true },
        })
      : [];
  const datasetName = new Map(datasets.map((d) => [d.id, d.name]));

  // Restrained per-run comparison summary from the SAME engine as run detail — batched
  // so the whole page costs a bounded number of queries (baseline runs + all results),
  // never a per-row N+1. For very large runs this is the natural summary/cache boundary.
  const baselineIds = [
    ...new Set(runs.map((r) => r.baselineRunId).filter((x): x is string => !!x)),
  ];
  const baselineRuns =
    baselineIds.length > 0
      ? await prisma.evaluationRun.findMany({ where: { id: { in: baselineIds }, projectId } })
      : [];
  const baselineById = new Map(baselineRuns.map((b) => [b.id, b]));

  const resultRunIds = [...new Set([...runs.map((r) => r.id), ...baselineIds])];
  const allResults =
    resultRunIds.length > 0
      ? await prisma.evaluationResult.findMany({
          where: { runId: { in: resultRunIds }, projectId },
          include: { scores: true },
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
    const statusCounts = countResultStatuses(resultsByRun.get(r.id) ?? []);
    return {
      ...r,
      evaluationName: r.evaluation.name,
      datasetName: datasetName.get(r.datasetId) ?? null,
      datasetVersionLabel: r.datasetVersion.label,
      // Delta + regressed-case count only when trustworthy; otherwise null (UI shows —),
      // never a misleading number beside an incompatible baseline.
      changeFromBaseline: comparison.trustworthy ? comparison.mainScore.delta : null,
      regressedCaseCount: comparison.trustworthy ? comparison.caseCounts.regressed : null,
      baselineComparable: comparison.trustworthy,
      errorCount: r.taskErrorCount + r.scorerErrorCount,
      elapsedMs: elapsedMs(r.startedAt, r.completedAt),
      ...statusCounts,
    };
  });

  return successResponse({ data, meta: { page, limit, total } });
}
