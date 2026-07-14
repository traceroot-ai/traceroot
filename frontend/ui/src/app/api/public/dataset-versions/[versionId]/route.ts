import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import { decodeJsonValue } from "@/lib/eval/json-value";
import { TEST_CASE_ORDER } from "@/lib/eval/versions";

type RouteParams = { params: Promise<{ versionId: string }> };

// GET /api/public/dataset-versions/[versionId] — SDK fetches the immutable
// snapshot it will run against: the version plus its test-case items.
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { versionId } = await params;

  const version = await prisma.datasetVersion.findFirst({
    where: { id: versionId, projectId },
    include: {
      dataset: { select: { clientDatasetId: true } },
      // Pulling the same version twice must yield the same order. create_time
      // alone does not: Postgres' CURRENT_TIMESTAMP default is the transaction
      // start time, so every case a publish writes shares one value, and among
      // ties the row order is whatever the plan happens to produce. testCaseId
      // is unique within a version, so it makes the order total.
      testCases: { orderBy: TEST_CASE_ORDER },
    },
  });
  if (!version) return NextResponse.json({ error: "Dataset version not found" }, { status: 404 });

  return NextResponse.json({
    dataset_version_id: version.id,
    dataset_id: version.dataset.clientDatasetId ?? version.datasetId,
    version_number: version.versionNumber,
    label: version.label,
    // input/expected are returned as NATIVE JSON values (decoded from the stored
    // JSON-encoded text). Legacy plain-text rows fall back to the raw string.
    items: version.testCases.map((t) => ({
      test_case_id: t.testCaseId,
      input: decodeJsonValue(t.input),
      expected: t.expected === null ? null : decodeJsonValue(t.expected),
      metadata: t.metadata,
      source_trace_id: t.sourceTraceId,
      source_span_id: t.sourceSpanId,
    })),
  });
}
