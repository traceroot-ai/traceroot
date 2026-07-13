import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

// GET — dataset test cases captured from this trace (span → dataset linkage).
// Powers the "In <dataset>" chip on a span in the trace panel: it marks spans
// that have already been saved as a test case. Only the dataset's CURRENT
// version is reported, so an edited case shows its dataset once, not once per
// historical snapshot. Read from Postgres, so it works without ClickHouse.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, traceId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const cases = await prisma.testCase.findMany({
    where: { projectId, sourceTraceId: traceId },
    select: {
      testCaseId: true,
      datasetId: true,
      datasetVersionId: true,
      sourceSpanId: true,
      review: true,
      version: {
        select: { dataset: { select: { name: true, currentVersionId: true } } },
      },
    },
  });

  const data = cases
    // Keep only cases that live in their dataset's current version.
    .filter((c) => c.datasetVersionId === c.version.dataset.currentVersionId)
    .map((c) => ({
      testCaseId: c.testCaseId,
      datasetId: c.datasetId,
      datasetName: c.version.dataset.name,
      sourceSpanId: c.sourceSpanId,
      review: c.review,
    }));

  return successResponse({ data });
}
