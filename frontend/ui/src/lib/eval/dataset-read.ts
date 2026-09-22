import { prisma, type Prisma } from "@traceroot/core";
import { decodeJsonValue } from "@/lib/eval/json-value";
import type { EvalReadResult } from "@/lib/eval/read-result";
import { resolvePublicDataset, TEST_CASE_ORDER } from "@/lib/eval/versions";

/**
 * The dataset reads, inside a project the caller has ALREADY resolved.
 *
 * Shared by the API-key routes under `/api/public/{datasets,dataset-versions}` and the
 * secret-authed internal route the backend reads through, so both surfaces answer from
 * one body with the same error strings and the same bounds.
 *
 * Datasets are authored catalog data, not time-windowed telemetry, so no retention window
 * applies here — the same as every other dataset route.
 */

export const DATASET_LIST_DEFAULT_LIMIT = 50;
export const DATASET_LIST_MAX_LIMIT = 200;
// A version's cases page at a larger size than the catalog lists when a caller pages.
export const VERSION_CASES_DEFAULT_LIMIT = 200;
export const VERSION_CASES_MAX_LIMIT = 1000;

type Body = Record<string, unknown>;

/**
 * A cursor that names no row in the set being paged. Prisma treats a cursor as a position
 * in the ordering, not a membership test, so a stale, mistyped or foreign cursor would
 * otherwise answer with an empty last page (or a page from the wrong place) that looks
 * exactly like the end of the data. A client paging to completion would stop early and
 * keep a partial set.
 */
const INVALID_CURSOR = { ok: false, status: 400, error: "Invalid cursor" } as const;

/**
 * A page size from a query string or a JSON number, clamped rather than rejected, so no
 * read can return an unbounded page. Never below 1: a fraction such as 0.5 would floor to
 * an empty page that still claims a next page.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (raw === null || raw === undefined || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

/** List the project's datasets, newest first. The cursor is an opaque dataset row id. */
export async function listDatasetsPage(input: {
  projectId: string;
  limit: unknown;
  cursor: string | null;
  name: string | null;
}): Promise<EvalReadResult<Body>> {
  const { projectId, cursor } = input;
  const limit = clampLimit(input.limit, DATASET_LIST_DEFAULT_LIMIT, DATASET_LIST_MAX_LIMIT);
  const name = input.name?.trim();
  if (cursor && !(await prisma.dataset.findFirst({ where: { id: cursor, projectId } }))) {
    return INVALID_CURSOR;
  }

  const rows = await prisma.dataset.findMany({
    where: {
      projectId,
      ...(name ? { name: { contains: name, mode: "insensitive" as Prisma.QueryMode } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      clientDatasetId: true,
      key: true,
      name: true,
      description: true,
      currentVersionId: true,
      updateTime: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    ok: true,
    body: {
      datasets: page.map((d) => ({
        // The id the SDK addresses this dataset by: its own, or the row id for a
        // dataset created in the UI. next_cursor stays an opaque row id.
        dataset_id: d.clientDatasetId ?? d.id,
        name: d.name,
        description: d.description,
        current_dataset_version_id: d.currentVersionId,
        // The pre-image of dataset_id, so the SDK recovers its key when key != name.
        key: d.key,
        updated_at: d.updateTime.toISOString(),
      })),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    },
  };
}

/**
 * One dataset by the id the SDK addresses it by (its own id, or the row id for a UI
 * dataset), with the current published version to pin. Another tenant using the same id
 * reaches its own dataset and never this one.
 */
export async function getDatasetDetail(input: {
  projectId: string;
  datasetId: string;
}): Promise<EvalReadResult<Body>> {
  const dataset = await resolvePublicDataset(prisma, input.projectId, input.datasetId);
  if (!dataset) return { ok: false, status: 404, error: "Dataset not found" };
  return {
    ok: true,
    body: {
      dataset_id: input.datasetId,
      name: dataset.name,
      description: dataset.description,
      current_dataset_version_id: dataset.currentVersionId,
      // The pre-image of dataset_id, so a pulled dataset recovers its key (key != name).
      key: dataset.key,
    },
  };
}

/** A dataset's versions, newest first, each with its case count. */
export async function listDatasetVersionsPage(input: {
  projectId: string;
  datasetId: string;
  limit: unknown;
  cursor: string | null;
}): Promise<EvalReadResult<Body>> {
  const { projectId, cursor } = input;
  const dataset = await resolvePublicDataset(prisma, projectId, input.datasetId);
  if (!dataset) return { ok: false, status: 404, error: "Dataset not found" };
  const limit = clampLimit(input.limit, DATASET_LIST_DEFAULT_LIMIT, DATASET_LIST_MAX_LIMIT);
  if (
    cursor &&
    !(await prisma.datasetVersion.findFirst({
      where: { id: cursor, datasetId: dataset.id, projectId },
    }))
  ) {
    return INVALID_CURSOR;
  }

  const rows = await prisma.datasetVersion.findMany({
    where: { datasetId: dataset.id, projectId },
    orderBy: { versionNumber: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, versionNumber: true, label: true, note: true, createTime: true },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // One grouped aggregate for the whole page instead of a per-version count (avoids an
  // N+1 of up to the page size), mirroring the datasets-list route.
  const versionIds = page.map((v) => v.id);
  const caseCounts =
    versionIds.length > 0
      ? await prisma.testCase.groupBy({
          by: ["datasetVersionId"],
          where: { datasetVersionId: { in: versionIds } },
          _count: { _all: true },
        })
      : [];
  const countByVersion = new Map(caseCounts.map((c) => [c.datasetVersionId, c._count._all]));

  const versions = page.map((v) => ({
    dataset_version_id: v.id,
    version_number: v.versionNumber,
    label: v.label,
    note: v.note,
    case_count: countByVersion.get(v.id) ?? 0,
    created_at: v.createTime.toISOString(),
    is_current: v.id === dataset.currentVersionId,
  }));
  return { ok: true, body: { versions, next_cursor: hasMore ? page[page.length - 1].id : null } };
}

/**
 * One immutable version plus its test cases: the whole set, or a page of it.
 *
 * Paging is opt-in. A request that names neither `limit` nor `cursor` gets every case with
 * `next_cursor: null`, exactly as this read always answered: the released SDKs pull the
 * snapshot they will run with ONE request and never follow a cursor, so a default page
 * would silently hand them a truncated dataset and a wrong case count. Passing `limit`
 * (as the tools and the CLI are told to) pages, because a version's case set is unbounded
 * in practice — each publish carries every earlier case forward.
 */
export async function getDatasetVersionPage(input: {
  projectId: string;
  versionId: string;
  limit: unknown;
  cursor: string | null;
}): Promise<EvalReadResult<Body>> {
  const { projectId, cursor } = input;
  const whole =
    (input.limit === null || input.limit === undefined || input.limit === "") && !cursor;
  const limit = whole
    ? null
    : clampLimit(input.limit, VERSION_CASES_DEFAULT_LIMIT, VERSION_CASES_MAX_LIMIT);

  const version = await prisma.datasetVersion.findFirst({
    where: { id: input.versionId, projectId },
    include: { dataset: { select: { clientDatasetId: true } } },
  });
  if (!version) return { ok: false, status: 404, error: "Dataset version not found" };
  if (
    cursor &&
    !(await prisma.testCase.findFirst({
      where: { id: cursor, datasetVersionId: version.id, projectId },
    }))
  ) {
    return INVALID_CURSOR;
  }

  // Cases are fetched separately now that they are paged. Pulling the same version twice
  // must yield the same order, and create_time alone does not: Postgres' CURRENT_TIMESTAMP
  // default is the transaction start time, so every case a publish writes shares one
  // value, and among ties the row order is whatever the plan happens to produce.
  // testCaseId is unique within a version, so it makes the order total — which is also
  // what makes cursor paging over this set stable rather than able to skip or repeat.
  const rows = await prisma.testCase.findMany({
    where: { datasetVersionId: version.id, projectId },
    orderBy: TEST_CASE_ORDER,
    ...(limit === null ? {} : { take: limit + 1 }),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      testCaseId: true,
      input: true,
      expected: true,
      metadata: true,
      sourceTraceId: true,
      sourceSpanId: true,
    },
  });

  const hasMore = limit !== null && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    ok: true,
    body: {
      dataset_version_id: version.id,
      dataset_id: version.dataset.clientDatasetId ?? version.datasetId,
      version_number: version.versionNumber,
      label: version.label,
      // input/expected are returned as NATIVE JSON values (decoded from the stored
      // JSON-encoded text). Legacy plain-text rows fall back to the raw string.
      items: page.map((t) => ({
        test_case_id: t.testCaseId,
        input: decodeJsonValue(t.input),
        expected: t.expected === null ? null : decodeJsonValue(t.expected),
        metadata: t.metadata,
        source_trace_id: t.sourceTraceId,
        source_span_id: t.sourceSpanId,
      })),
      // An opaque row id, like every other cursor on this surface. Null at the end, so a
      // client loops until it is null rather than comparing counts.
      next_cursor: hasMore ? page[page.length - 1].id : null,
    },
  };
}
