import { NextResponse } from "next/server";
import {
  prisma,
  PublishDatasetVersionRequestSchema,
  DATASET_VERSION_MAX_CHANGES,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import {
  publishDatasetVersion,
  DatasetNotFound,
  VersionConflict,
  type TestCaseSeed,
} from "@/lib/eval/versions";

type RouteParams = { params: Promise<{ datasetId: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** input/expected arrive as any JSON; store as text (non-strings are stringified). */
function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// POST /api/public/datasets/[datasetId]/versions — publish ONE immutable version
// from a batch of test-case changes (A4). One call → one version, atomically.
// Optimistic concurrency on base_version_id (409 on mismatch); idempotency_key
// makes a retried publish return the same version.
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { datasetId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PublishDatasetVersionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const c = parsed.data;

  if (c.changes.length > DATASET_VERSION_MAX_CHANGES) {
    return NextResponse.json(
      { error: "Too many changes in one publish", limit: DATASET_VERSION_MAX_CHANGES },
      { status: 413 },
    );
  }

  try {
    const result = await publishDatasetVersion({
      datasetId,
      projectId,
      label: c.label,
      baseVersionId: c.base_version_id,
      idempotencyKey: c.idempotency_key ?? null,
      note: "Published from the SDK",
      transform: (current) => {
        // Fold the changes over the current cases, keyed by stable test_case_id.
        // upsert = full-case replace/add; archive and delete both drop the case
        // from the new version (older immutable snapshots always retain it).
        const byId = new Map<string, TestCaseSeed>(current.map((s) => [s.testCaseId, s]));
        for (const ch of c.changes) {
          if (ch.op !== "upsert") {
            byId.delete(ch.test_case_id);
            continue;
          }
          const prev = byId.get(ch.test_case_id);
          byId.set(ch.test_case_id, {
            testCaseId: ch.test_case_id,
            input: ch.input !== undefined ? toText(ch.input) : (prev?.input ?? ""),
            expected: ch.expected === undefined ? (prev?.expected ?? null) : toText(ch.expected),
            recordedOutput: prev?.recordedOutput ?? null,
            metadata: ch.metadata !== undefined ? ch.metadata : (prev?.metadata ?? null),
            review: prev?.review ?? "needs_review",
            captureReason: prev?.captureReason ?? "manual",
            sourceTraceId: ch.source_trace_id ?? prev?.sourceTraceId ?? null,
            sourceSpanId: ch.source_span_id ?? prev?.sourceSpanId ?? null,
            sourceSpanName: prev?.sourceSpanName ?? null,
            sourceSpanKind: prev?.sourceSpanKind ?? null,
            addedBy: prev?.addedBy ?? null,
            createTime: prev?.createTime, // preserve for existing; new cases default to now
          });
        }
        return {
          cases: [...byId.values()],
          focusTestCaseId: c.changes[c.changes.length - 1].test_case_id,
        };
      },
    });

    return NextResponse.json(
      {
        dataset_id: datasetId,
        dataset_version_id: result.versionId,
        version_number: result.versionNumber,
        case_count: result.caseCount,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof DatasetNotFound) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }
    if (err instanceof VersionConflict) {
      return NextResponse.json(
        {
          error: "conflict",
          base_version_id: c.base_version_id,
          current_version_id: err.currentVersionId,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}

// GET /api/public/datasets/[datasetId]/versions?limit=&cursor= — list versions (A5),
// newest-first, cursor-paginated.
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { datasetId } = await params;

  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true, currentVersionId: true },
  });
  if (!dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const cursor = url.searchParams.get("cursor");

  const rows = await prisma.datasetVersion.findMany({
    where: { datasetId, projectId },
    orderBy: { versionNumber: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, versionNumber: true, label: true, note: true, createTime: true },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const versions = await Promise.all(
    page.map(async (v) => ({
      dataset_version_id: v.id,
      version_number: v.versionNumber,
      label: v.label,
      note: v.note,
      case_count: await prisma.testCase.count({ where: { datasetVersionId: v.id } }),
      created_at: v.createTime.toISOString(),
      is_current: v.id === dataset.currentVersionId,
    })),
  );
  return NextResponse.json({ versions, next_cursor: hasMore ? page[page.length - 1].id : null });
}
