import { NextRequest } from "next/server";
import { prisma, Role, CreateTestCaseRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import {
  publishDatasetVersion,
  canonicalJson,
  DatasetNotFound,
  VersionConflict,
} from "@/lib/eval/versions";
import { nextCaseId } from "@/lib/eval/case-id";
import { encodeJsonValue, decodeJsonValue } from "@/lib/eval/json-value";

type RouteParams = { params: Promise<{ projectId: string; datasetId: string }> };

// POST — save a trace/span (or a manual case) as a test case. Publishes a NEW
// dataset version so any run that pinned an earlier snapshot is untouched. If the
// same source span already exists in the current version, returns that case
// instead of silently duplicating it.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = CreateTestCaseRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);
  const c = parsed.data;

  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true, currentVersionId: true, key: true, name: true },
  });
  if (!dataset) return errorResponse("Dataset not found", 404);

  // The pre-image the case id is hashed from — the dataset's stable key, which by
  // convention defaults to its display name (see the SDK's `key = key ?? name`).
  // A UI-created dataset stores `key = name`; legacy rows with a null key fall back
  // to the name so the derivation still matches an SDK author using the same key.
  const datasetKey = dataset.key ?? dataset.name;

  // Explicit duplicate handling: same source span already in the current version.
  if (dataset.currentVersionId && c.source_trace_id && c.source_span_id) {
    const dup = await prisma.testCase.findFirst({
      where: {
        datasetVersionId: dataset.currentVersionId,
        sourceTraceId: c.source_trace_id,
        sourceSpanId: c.source_span_id,
      },
      select: { testCaseId: true },
    });
    if (dup) {
      return successResponse({
        duplicate: true,
        testCaseId: dup.testCaseId,
        versionId: dataset.currentVersionId,
      });
    }
  }

  // Stored JSON-ENCODED, the one on-disk encoding for these columns (the public
  // publish path and the pull path agree on it). Written raw, a case authored here
  // as the text "123" would come back from the public API as the number 123 — a type
  // change inside a snapshot a run scores against.
  const encodedInput = encodeJsonValue(c.input);
  // The canonical-JSON of the case's input is what the id is hashed from — computed on
  // the DECODED value so it matches an SDK author (whose SDK canonicalizes the native
  // input) and matches the occurrence comparison against existing cases below.
  const canonicalInput = canonicalJson(decodeJsonValue(encodedInput));
  try {
    const result = await publishDatasetVersion({
      datasetId,
      projectId,
      createdBy: authResult.user.email ?? null,
      note: "Added a test case from a trace",
      transform: (current) => {
        // CONTENT-addressed id (parity with the SDK's `stableCaseId`): the same input
        // authored in the UI and pushed from the SDK under the same dataset key converge
        // on one `tc_` id, so re-publishing matches (upsert on id) instead of duplicating.
        // `occurrence` disambiguates duplicate inputs — the first slot whose id is still
        // free, mirroring the SDK so a gap left by a delete never re-mints a live id.
        const existingIds = new Set(current.map((s) => s.testCaseId));
        const { testCaseId } = nextCaseId(existingIds, datasetKey, canonicalInput);
        return {
          focusTestCaseId: testCaseId,
          cases: [
            ...current,
            {
              testCaseId,
              input: encodedInput,
              expected:
                c.expected === null || c.expected === undefined
                  ? null
                  : encodeJsonValue(c.expected),
              metadata: (c.metadata ?? null) as Record<string, unknown> | null,
              review: c.review,
              captureReason: c.capture_reason,
              sourceTraceId: c.source_trace_id ?? null,
              sourceSpanId: c.source_span_id ?? null,
              sourceSpanName: c.source_span_name ?? null,
              sourceSpanKind: c.source_span_kind ?? null,
              addedBy: authResult.user.email ?? null,
            },
          ],
        };
      },
    });
    return successResponse({ duplicate: false, ...result }, 201);
  } catch (err) {
    if (err instanceof DatasetNotFound) return errorResponse("Dataset not found", 404);
    // Another publish kept winning the pointer swap; ask the caller to retry
    // rather than surfacing the conflict as a 500.
    if (err instanceof VersionConflict) {
      return errorResponse("The dataset changed while saving; please retry", 409);
    }
    throw err;
  }
}
