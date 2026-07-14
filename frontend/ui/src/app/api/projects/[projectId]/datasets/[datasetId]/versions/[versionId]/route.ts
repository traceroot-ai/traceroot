import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = {
  params: Promise<{ projectId: string; datasetId: string; versionId: string }>;
};

// GET — a specific immutable dataset version and the test cases it snapshotted.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId, versionId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const version = await prisma.datasetVersion.findFirst({
    where: { id: versionId, datasetId, projectId },
    include: { testCases: { orderBy: { createTime: "asc" } } },
  });
  if (!version) return errorResponse("Dataset version not found", 404);

  return successResponse({ version, testCases: version.testCases });
}
