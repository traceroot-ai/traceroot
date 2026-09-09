import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

// GET — evaluation results produced by this trace (trace → evaluation linkage).
// Mirrors the detector-findings-by-trace pattern; surfaced as an Evaluation tab/
// badge in the trace panel. Read from Postgres, so it works without ClickHouse.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const results = await prisma.evaluationResult.findMany({
    where: { projectId, traceId },
    orderBy: { createTime: "desc" },
    include: {
      scores: { orderBy: { createTime: "asc" } },
      run: {
        select: {
          id: true,
          runNumber: true,
          candidateVersion: true,
          datasetId: true,
          datasetVersionId: true,
          evaluation: { select: { id: true, name: true } },
          datasetVersion: { select: { label: true } },
        },
      },
    },
  });

  return successResponse({ data: results });
}
