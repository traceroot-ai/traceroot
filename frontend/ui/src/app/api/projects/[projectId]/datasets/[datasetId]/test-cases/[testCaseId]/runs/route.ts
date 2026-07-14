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
  const { projectId, testCaseId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const results = await prisma.evaluationResult.findMany({
    where: { projectId, testCaseId },
    orderBy: { createTime: "desc" },
    select: {
      id: true,
      mainScore: true,
      status: true,
      change: true,
      createTime: true,
      run: {
        select: {
          id: true,
          runNumber: true,
          candidateVersion: true,
          startedAt: true,
          evaluation: { select: { name: true } },
        },
      },
    },
  });

  const data = results.map((r) => ({
    resultId: r.id,
    runId: r.run.id,
    runNumber: r.run.runNumber,
    candidateVersion: r.run.candidateVersion,
    evaluationName: r.run.evaluation.name,
    ranAt: r.run.startedAt.toISOString(),
    score: r.mainScore,
    status: r.status,
    change: r.change,
  }));

  return successResponse({ data });
}
