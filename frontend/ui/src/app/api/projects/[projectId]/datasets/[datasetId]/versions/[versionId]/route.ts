import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { TEST_CASE_ORDER } from "@/lib/eval/versions";
import { displayJsonValue } from "@/lib/eval/json-value";

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
    // Same total order as the public pull: a version's cases read identically
    // everywhere, including when every row shares one create_time.
    include: { testCases: { orderBy: TEST_CASE_ORDER } },
  });
  if (!version) return errorResponse("Dataset version not found", 404);

  // Decode input/expected for display, matching the current-version route — otherwise
  // the same case renders as raw JSON-encoded text here (e.g. `"hello"`, `42`) but
  // decoded in the current view.
  const testCases = version.testCases.map((t) => ({
    ...t,
    input: displayJsonValue(t.input),
    expected: t.expected === null ? null : displayJsonValue(t.expected),
  }));

  return successResponse({ version: { ...version, testCases }, testCases });
}
