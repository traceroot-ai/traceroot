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

  // Lineage aggregate, derived at read time like every other eval number. Metric-first:
  // a run has no single headline score, so the lineage carries no averaged score — cost
  // and duration are summed from the per-case results (so they add up to the per-case rows),
  // not run wall-clock.
  const evaluationIds = evaluations.map((e) => e.id);
  const resultAggregates =
    evaluationIds.length > 0
      ? await prisma.evaluationResult.groupBy({
          by: ["evaluationId"],
          where: { projectId, evaluationId: { in: evaluationIds } },
          _sum: { cost: true, durationMs: true },
        })
      : [];
  const resultAggByEvaluation = new Map(resultAggregates.map((a) => [a.evaluationId, a]));

  const data = evaluations.map((e) => {
    const latestRun = e.runs[0] ?? null;
    const resultAgg = resultAggByEvaluation.get(e.id);
    return {
      ...e,
      datasetName: datasetName.get(e.datasetId) ?? null,
      runCount: e._count.runs,
      latestRun,
      aggregate: {
        runCount: e._count.runs,
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
