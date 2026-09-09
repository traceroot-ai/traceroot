import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = {
  params: Promise<{ projectId: string; datasetId: string; testCaseId: string }>;
};

// GET — every evaluation run that measured this test case (by stable testCaseId),
// newest first, with the result this case got in each. Powers the CasePanel "Runs"
// tab. testCaseId is globally unique, so the dataset in the path is for grouping
// and access scoping only.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId, testCaseId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  // A stable testCaseId can recur across datasets in the same project (it's only
  // unique within a dataset lineage), so scope through the run's dataset — otherwise
  // this tab would surface runs from a different dataset that reused the id.
  const results = await prisma.evaluationResult.findMany({
    where: { projectId, testCaseId, run: { datasetId } },
    orderBy: { createTime: "desc" },
    select: {
      id: true,
      status: true,
      change: true,
      createTime: true,
      run: {
        select: {
          id: true,
          runNumber: true,
          candidateVersion: true,
          startedAt: true,
          datasetVersionId: true,
          // Declared case count — the SAME denominator the Experiments list uses for
          // Avg Cost / Avg Duration, so the two surfaces agree even on partial runs.
          caseCount: true,
          evaluation: { select: { name: true } },
        },
      },
    },
  });

  // Run-level cost/duration, summed over ALL of each run's results (not just this
  // case) — the same aggregation the runs list uses, so the panel's Cost / Duration
  // (and the averages over the declared caseCount) match the Experiments list.
  const runIds = [...new Set(results.map((r) => r.run.id))];
  const runAgg = runIds.length
    ? await prisma.evaluationResult.groupBy({
        by: ["runId"],
        where: { runId: { in: runIds } },
        _sum: { cost: true, durationMs: true },
      })
    : [];
  const aggByRun = new Map(runAgg.map((a) => [a.runId, a]));

  const data = results.map((r) => {
    const agg = aggByRun.get(r.run.id);
    return {
      resultId: r.id,
      runId: r.run.id,
      runNumber: r.run.runNumber,
      candidateVersion: r.run.candidateVersion,
      evaluationName: r.run.evaluation.name,
      datasetVersionId: r.run.datasetVersionId,
      ranAt: r.run.startedAt.toISOString(),
      status: r.status,
      change: r.change,
      caseCount: r.run.caseCount,
      cost: agg?._sum.cost ?? null,
      elapsedMs: agg?._sum.durationMs ?? null,
    };
  });

  return successResponse({ data });
}
