import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

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
    include: { testCases: { orderBy: { createTime: "asc" } } },
  });
  if (!version) return NextResponse.json({ error: "Dataset version not found" }, { status: 404 });

  return NextResponse.json({
    dataset_version_id: version.id,
    dataset_id: version.datasetId,
    version_number: version.versionNumber,
    label: version.label,
    items: version.testCases.map((t) => ({
      test_case_id: t.testCaseId,
      input: t.input,
      expected: t.expected,
      metadata: t.metadata,
      source_trace_id: t.sourceTraceId,
      source_span_id: t.sourceSpanId,
    })),
  });
}
