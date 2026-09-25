import { NextResponse } from "next/server";
import {
  prisma,
  PublishDatasetVersionRequestSchema,
  DATASET_VERSION_MAX_CHANGES,
  DATASET_VERSION_MAX_BYTES,
  serializedByteLength,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import {
  publishDatasetVersion,
  resolvePublicDataset,
  DatasetNotFound,
  VersionConflict,
  type TestCaseSeed,
} from "@/lib/eval/versions";
import { listDatasetVersionsPage } from "@/lib/eval/dataset-read";
import { encodeJsonValue } from "@/lib/eval/json-value";
import { evalReadResponse } from "@/lib/eval/read-result";
import { readLimitedJson } from "@/lib/eval/body";
import { isPrismaKnownError, prismaErrorTarget } from "@/lib/eval/prisma-errors";

type RouteParams = { params: Promise<{ datasetId: string }> };

// POST /api/public/datasets/[datasetId]/versions — publish ONE immutable version
// from a batch of test-case changes (A4). One call → one version, atomically.
// Optimistic concurrency on base_version_id (409 on mismatch); idempotency_key
// makes a retried publish return the same version.
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { datasetId } = await params;

  // Bound the body on the wire, BEFORE it is buffered and parsed: a count cap
  // cannot stop 1000 changes each carrying a multi-megabyte `input`, and by the
  // time a parsed payload could be measured it is already resident in memory.
  const body = await readLimitedJson(request, DATASET_VERSION_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      body.status === 413
        ? { error: body.error, limit_bytes: DATASET_VERSION_MAX_BYTES }
        : { error: body.error },
      { status: body.status },
    );
  }
  const parsed = PublishDatasetVersionRequestSchema.safeParse(body.value);
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

  // Per-value caps live in the contract; this bounds their SUM, which is what the
  // transaction actually writes.
  const totalBytes = c.changes.reduce(
    (sum, ch) =>
      ch.op !== "upsert"
        ? sum
        : sum +
          serializedByteLength(ch.input) +
          serializedByteLength(ch.expected) +
          serializedByteLength(ch.metadata),
    0,
  );
  if (totalBytes > DATASET_VERSION_MAX_BYTES) {
    return NextResponse.json(
      { error: "Publish payload too large", limit_bytes: DATASET_VERSION_MAX_BYTES },
      { status: 413 },
    );
  }

  try {
    const result = await publishDatasetVersion({
      clientDatasetId: datasetId,
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
            // Store input/expected JSON-ENCODED so native types (incl. genuine
            // JSON-looking strings) round-trip on read. See lib/eval/json-value.
            input: ch.input !== undefined ? encodeJsonValue(ch.input) : (prev?.input ?? ""),
            expected:
              ch.expected === undefined ? (prev?.expected ?? null) : encodeJsonValue(ch.expected),
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
    // Backstop for a constraint violation that outlived the retries in
    // publishDatasetVersion. An SDK that retries on 409 and treats a repeated
    // 200 as success must never see an opaque 500 here — least of all for an
    // idempotency key, where a 500 leaves it unable to tell if the publish landed.
    if (isPrismaKnownError(err, "P2002")) {
      const dataset = await resolvePublicDataset(prisma, projectId, datasetId);
      const target = prismaErrorTarget(err);
      if (dataset && c.idempotency_key && target.includes("idempotency")) {
        const landed = await prisma.datasetVersion.findFirst({
          where: { datasetId: dataset.id, idempotencyKey: c.idempotency_key },
          select: { id: true, versionNumber: true },
        });
        if (landed) {
          return NextResponse.json(
            {
              dataset_id: datasetId,
              dataset_version_id: landed.id,
              version_number: landed.versionNumber,
              case_count: await prisma.testCase.count({
                where: { datasetVersionId: landed.id },
              }),
            },
            { status: 200 },
          );
        }
      }
      return NextResponse.json(
        {
          error: "conflict",
          base_version_id: c.base_version_id,
          current_version_id: dataset?.currentVersionId ?? null,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}

// GET /api/public/datasets/[datasetId]/versions?limit=&cursor= — list versions (A5),
// newest-first, cursor-paginated. The read is shared with the internal route
// (`listDatasetVersionsPage`).
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { datasetId } = await params;
  const url = new URL(request.url);
  return evalReadResponse(
    await listDatasetVersionsPage({
      projectId: auth.projectId,
      datasetId,
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
    }),
  );
}
