import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { toRunCoverage } from "@/lib/eval/coverage";
import { runAverages } from "@/lib/eval/run-summary";

type RouteParams = {
  params: Promise<{ projectId: string; datasetId: string; testCaseId: string }>;
};

// GET — every evaluation run that measured this test case (by stable testCaseId),
// newest first, with the result this case got in each. Powers the CasePanel "Runs"
// tab. testCaseId is globally unique, so the dataset in the path is for grouping
// and access scoping only.
async function handleGET(_req: NextRequest, { params }: RouteParams) {
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
          // Declared case count — kept for the run read model. The averages below do not
          // divide by it (see avgCost).
          caseCount: true,
          // The run's dataset coverage, read through the same helper as every other
          // surface so this panel cannot describe a run differently from the runs list.
          datasetCaseCount: true,
          selectionMode: true,
          selectedCaseCount: true,
          sampleSeed: true,
          evaluation: { select: { name: true } },
        },
      },
    },
  });

  // Run-level cost/duration, summed over ALL of each run's results (not just this
  // case) — the same aggregation the runs list uses, so the panel's Cost / Duration
  // and their averages match the Experiments list.
  const runIds = [...new Set(results.map((r) => r.run.id))];
  const runAgg = runIds.length
    ? await prisma.evaluationResult.groupBy({
        by: ["runId"],
        where: { runId: { in: runIds } },
        _sum: { cost: true, durationMs: true },
        // Counted per column alongside the sums, so each average divides by the results
        // that reported it, matching the Experiments list exactly.
        _count: { cost: true, durationMs: true },
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
      coverage: toRunCoverage(r.run),
      cost: agg?._sum.cost ?? null,
      elapsedMs: agg?._sum.durationMs ?? null,
      // Per-case means over the results that reported each value — the same helper as
      // the runs list and the public run read.
      ...runAverages(
        { cost: agg?._sum.cost ?? null, durationMs: agg?._sum.durationMs ?? null },
        { cost: agg?._count.cost ?? 0, durationMs: agg?._count.durationMs ?? 0 },
      ),
    };
  });

  return successResponse({ data });
}
export const GET = withImpersonationPolicy(handleGET);
