import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; runId: string }> };

// GET — a single evaluation run with its results, scores, and human scores.
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
        include: {
          scores: { orderBy: { createTime: "asc" } },
          humanScores: { orderBy: { createTime: "desc" } },
        },
      },
    },
  });
  if (!run) return errorResponse("Evaluation run not found", 404);

  const dataset = await prisma.dataset.findFirst({
    where: { id: run.datasetId, projectId },
    select: { id: true, name: true },
  });

  // Baseline delta only when the two runs measured the identical population.
  const baseline = run.baselineRun;
  const comparable =
    !!baseline &&
    baseline.evaluationId === run.evaluationId &&
    baseline.datasetVersionId === run.datasetVersionId;
  const changeFromBaseline =
    comparable && run.mainScore !== null && baseline!.mainScore !== null
      ? run.mainScore - baseline!.mainScore
      : null;

  const { results, ...runFields } = run;
  return successResponse({
    run: {
      ...runFields,
      evaluationName: run.evaluation.name,
      datasetName: dataset?.name ?? null,
      datasetVersionLabel: run.datasetVersion.label,
      changeFromBaseline,
      baselineComparable: comparable,
      errorCount: run.taskErrorCount + run.scorerErrorCount,
    },
    results,
  });
}
