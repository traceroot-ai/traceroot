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

  const data = evaluations.map((e) => ({
    ...e,
    datasetName: datasetName.get(e.datasetId) ?? null,
    runCount: e._count.runs,
    latestRun: e.runs[0] ?? null,
  }));

  return successResponse({ data });
}
