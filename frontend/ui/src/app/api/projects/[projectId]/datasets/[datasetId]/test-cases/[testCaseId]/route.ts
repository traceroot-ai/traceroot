import { NextRequest } from "next/server";
import { prisma, Role, UpdateTestCaseRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { publishDatasetVersion, DatasetNotFound, VersionConflict } from "@/lib/eval/versions";
import { encodeEditedText } from "@/lib/eval/json-value";

type RouteParams = {
  params: Promise<{ projectId: string; datasetId: string; testCaseId: string }>;
};

// PATCH — edit a test case. This publishes a NEW dataset version (the historical
// snapshot a run pinned is never rewritten). Editing content returns a "ready"
// case to "needs_review" unless the caller sets review explicitly.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId, testCaseId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = UpdateTestCaseRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);
  const patch = parsed.data;

  const touchesContent =
    patch.input !== undefined || patch.expected !== undefined || patch.metadata !== undefined;

  // Guard before publishing so a missing case never creates a no-op version.
  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { currentVersionId: true },
  });
  if (!dataset) return errorResponse("Dataset not found", 404);
  const exists = dataset.currentVersionId
    ? await prisma.testCase.findFirst({
        where: { datasetVersionId: dataset.currentVersionId, testCaseId },
        select: { id: true },
      })
    : null;
  if (!exists) return errorResponse("Test case not found in the current version", 404);

  try {
    const result = await publishDatasetVersion({
      datasetId,
      projectId,
      createdBy: authResult.user.email ?? null,
      note: `Edited test case ${testCaseId}`,
      transform: (current) => ({
        focusTestCaseId: testCaseId,
        cases: current.map((seed) => {
          if (seed.testCaseId !== testCaseId) return seed;
          const demote = touchesContent && seed.review === "ready" && patch.review === undefined;
          return {
            ...seed,
            // The UI edits values as text, but the column holds one encoding
            // (JSON-encoded) shared with the SDK publish/pull paths. Re-encode
            // against the value being replaced so an edit cannot silently change
            // a case's type inside the snapshot a run scores against.
            ...(patch.input !== undefined
              ? { input: encodeEditedText(seed.input, patch.input) }
              : {}),
            ...(patch.expected !== undefined
              ? {
                  expected:
                    patch.expected === null
                      ? null
                      : encodeEditedText(seed.expected, patch.expected),
                }
              : {}),
            ...(patch.metadata !== undefined
              ? { metadata: patch.metadata as Record<string, unknown> | null }
              : {}),
            ...(patch.review !== undefined ? { review: patch.review } : {}),
            ...(demote ? { review: "needs_review" } : {}),
          };
        }),
      }),
    });
    return successResponse(result, 201);
  } catch (err) {
    if (err instanceof DatasetNotFound) return errorResponse("Dataset not found", 404);
    if (err instanceof VersionConflict) {
      return errorResponse("The dataset changed while saving; please retry", 409);
    }
    throw err;
  }
}
