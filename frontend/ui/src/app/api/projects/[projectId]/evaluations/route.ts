import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET — evaluation lineages (stable purposes) with their latest run + run count.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const evaluations = await prisma.evaluation.findMany({
    where: { projectId },
    orderBy: { updateTime: "desc" },
    include: {
      _count: { select: { runs: true } },
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: {
          id: true,
          runNumber: true,
          candidateVersion: true,
          status: true,
          mainScore: true,
          startedAt: true,
          datasetVersionId: true,
        },
      },
    },
  });

  const datasetIds = [...new Set(evaluations.map((e) => e.datasetId))];
  const datasets =
    datasetIds.length > 0
      ? await prisma.dataset.findMany({
          where: { id: { in: datasetIds }, projectId },
          select: { id: true, name: true },
        })
      : [];
  const datasetName = new Map(datasets.map((d) => [d.id, d.name]));

  // Lineage aggregate, derived at read time like every other eval number. Two grouped
  // queries for the whole list, never a per-lineage round trip.
  //
  // `_avg.mainScore` and `_count.mainScore` both ignore null, so the average covers
  // only runs that were actually scored and `scoredRunCount` reports that denominator.
  // Averaging over every run instead would drag a lineage toward 0 for runs that were
  // never judged — a quality collapse that never happened.
  const evaluationIds = evaluations.map((e) => e.id);
  const [runAggregates, resultAggregates] =
    evaluationIds.length > 0
      ? await Promise.all([
          prisma.evaluationRun.groupBy({
            by: ["evaluationId"],
            where: { projectId, evaluationId: { in: evaluationIds } },
            _avg: { mainScore: true },
            _count: { mainScore: true },
          }),
          // Cost and duration live per case, so the lineage totals sum the results.
          // `durationMs` is summed case time, matching how the runs list derives an
          // in-flight run's elapsed — not wall clock, which would count idle gaps.
          prisma.evaluationResult.groupBy({
            by: ["evaluationId"],
            where: { projectId, evaluationId: { in: evaluationIds } },
            _sum: { cost: true, durationMs: true },
          }),
        ])
      : [[], []];
  const runAggByEvaluation = new Map(runAggregates.map((a) => [a.evaluationId, a]));
  const resultAggByEvaluation = new Map(resultAggregates.map((a) => [a.evaluationId, a]));

  const data = evaluations.map((e) => {
    const latestRun = e.runs[0] ?? null;
    const runAgg = runAggByEvaluation.get(e.id);
    const resultAgg = resultAggByEvaluation.get(e.id);
    return {
      ...e,
      datasetName: datasetName.get(e.datasetId) ?? null,
      runCount: e._count.runs,
      latestRun,
      aggregate: {
        runCount: e._count.runs,
        scoredRunCount: runAgg?._count.mainScore ?? 0,
        // Null rather than 0 when no run in the lineage was ever scored.
        averageMainScore: runAgg?._avg.mainScore ?? null,
        totalCost: resultAgg?._sum.cost ?? null,
        totalDurationMs: resultAgg?._sum.durationMs ?? null,
        // Latest by the same run ordering the list already uses (startedAt desc).
        latestStatus: latestRun?.status ?? null,
        latestStartedAt: latestRun?.startedAt ?? null,
      },
    };
  });

  return successResponse({ data });
}
