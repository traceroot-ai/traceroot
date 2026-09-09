import { NextRequest } from "next/server";
import { Role, SaveResultToDatasetRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import {
  saveResultToDataset,
  ResultNotFound,
  NoOriginatingCase,
  CircularSaveConflict,
} from "@/lib/eval/result-to-dataset";
import { DatasetNotFound, VersionConflict } from "@/lib/eval/versions";
import { LoneSurrogateError } from "@/lib/eval/case-id";

type RouteParams = { params: Promise<{ projectId: string; resultId: string }> };

// POST — save this evaluation result into a dataset: update the originating case,
// save a new case, or duplicate as a variant. This is a dataset write (it publishes
// a new immutable version), never a scoring action, and it never copies the
// candidate output into `expected` implicitly.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, resultId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = SaveResultToDatasetRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);
  const d = parsed.data;

  // save/duplicate target an explicit dataset; update derives it from the result.
  if ((d.action === "save_new_case" || d.action === "duplicate_as_variant") && !d.dataset_id) {
    return errorResponse(`${d.action} requires a dataset_id`, 400);
  }

  try {
    const published = await saveResultToDataset({
      projectId,
      resultId,
      action: d.action,
      datasetId: d.dataset_id ?? undefined,
      input: d.input,
      expected: d.expected,
      useCandidateAsExpected: d.use_candidate_as_expected ?? false,
      metadata: d.metadata,
      idempotencyKey: d.idempotency_key ?? null,
      addedBy: authResult.user.email ?? authResult.user.id,
    });
    return successResponse(
      {
        dataset_id: published.datasetId,
        version_id: published.versionId,
        version_number: published.versionNumber,
        test_case_id: published.focusTestCaseId,
        case_count: published.caseCount,
        replayed: published.replayed,
      },
      201,
    );
  } catch (e) {
    if (e instanceof ResultNotFound) return errorResponse(e.message, 404);
    if (e instanceof DatasetNotFound) return errorResponse(e.message, 404);
    if (e instanceof NoOriginatingCase) return errorResponse(e.message, 409);
    // Actionable conflict: the message directs the client to update_existing_case.
    if (e instanceof CircularSaveConflict) return errorResponse(e.message, 409);
    if (e instanceof VersionConflict) return errorResponse("Dataset version conflict", 409);
    // A lone UTF-16 surrogate in the case input can't be canonicalized into a stable id;
    // that's a caller-fixable 400, not an unhandled 500 falling through to `throw e`.
    if (e instanceof LoneSurrogateError)
      return errorResponse("Input contains invalid Unicode", 400);
    throw e;
  }
}
