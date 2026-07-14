import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

/** Delta vs baseline only when the two runs measured the identical population. */
function changeFromBaseline(
  run: { mainScore: number | null; evaluationId: string; datasetVersionId: string },
  baseline: { mainScore: number | null; evaluationId: string; datasetVersionId: string } | null,
): number | null {
  if (!baseline || run.mainScore === null || baseline.mainScore === null) return null;
  if (
    baseline.evaluationId !== run.evaluationId ||
    baseline.datasetVersionId !== run.datasetVersionId
  ) {
    return null; // incompatible snapshot — no delta
  }
  return run.mainScore - baseline.mainScore;
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
        baselineRun: {
          select: { mainScore: true, evaluationId: true, datasetVersionId: true },
        },
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

  const data = runs.map((r) => ({
    ...r,
    evaluationName: r.evaluation.name,
    datasetName: datasetName.get(r.datasetId) ?? null,
    datasetVersionLabel: r.datasetVersion.label,
    changeFromBaseline: changeFromBaseline(r, r.baselineRun),
    errorCount: r.taskErrorCount + r.scorerErrorCount,
  }));

  return successResponse({ data, meta: { page, limit, total } });
}
