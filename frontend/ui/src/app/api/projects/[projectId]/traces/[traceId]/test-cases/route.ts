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
        select: {
          label: true,
          _count: { select: { testCases: true } },
          dataset: {
            select: { name: true, clientDatasetId: true, currentVersionId: true, updateTime: true },
          },
        },
      },
    },
  });

  const data = cases
    // Keep only cases that live in their dataset's current version.
    .filter((c) => c.datasetVersionId === c.version.dataset.currentVersionId)
    .map((c) => ({
      testCaseId: c.testCaseId,
      datasetId: c.datasetId,
      // The SDK-addressable id (the "ds_…" the SDK chose), null for UI-authored
      // datasets. The SDK snippet must target this — the public dataset endpoint
      // resolves `clientDatasetId` OR the cuid `id` (resolvePublicDataset), never
      // a slug of the display name, so the chip falls back to `datasetId` when null.
      datasetClientId: c.version.dataset.clientDatasetId,
      datasetName: c.version.dataset.name,
      sourceSpanId: c.sourceSpanId,
      review: c.review,
      datasetVersionLabel: c.version.label,
      datasetUpdatedAt: c.version.dataset.updateTime.toISOString(),
      caseCount: c.version._count.testCases,
    }));

  return successResponse({ data });
}
