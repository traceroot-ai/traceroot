import { NextRequest } from "next/server";
import { prisma, Role, CreateTestCaseRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { publishDatasetVersion, newTestCaseId, DatasetNotFound } from "@/lib/eval/versions";

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
    select: { id: true, currentVersionId: true },
  });
  if (!dataset) return errorResponse("Dataset not found", 404);

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

  const testCaseId = newTestCaseId();
  try {
    const result = await publishDatasetVersion({
      datasetId,
      projectId,
      createdBy: authResult.user.email ?? null,
      note: "Added a test case from a trace",
      transform: (current) => ({
        focusTestCaseId: testCaseId,
        cases: [
          ...current,
          {
            testCaseId,
            input: c.input,
            expected: c.expected ?? null,
            recordedOutput: c.recorded_output ?? null,
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
      }),
    });
    return successResponse({ duplicate: false, ...result }, 201);
  } catch (err) {
    if (err instanceof DatasetNotFound) return errorResponse("Dataset not found", 404);
    throw err;
  }
}
