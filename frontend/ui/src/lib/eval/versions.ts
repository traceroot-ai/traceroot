import { prisma, type Prisma, type TestCase } from "@traceroot/core";
import { versionSnowflakeFromMs } from "./snowflake";
import { decodeJsonValue } from "./json-value";
import { rejectLoneSurrogate } from "./case-id";

/** Deterministic read order for a version's cases (see the ordering note where
 *  it's used): every case a publish writes shares one `create_time` (Postgres'
 *  `CURRENT_TIMESTAMP` default is the transaction start time), so `testCaseId`
 *  breaks the tie and makes the order total instead of "whatever the plan does". */
export const TEST_CASE_ORDER = [{ createTime: "asc" as const }, { testCaseId: "asc" as const }];

/**
 * Dataset-version publishing — the immutability core.
 *
 * A dataset never mutates its historical snapshots. Adding or editing a test
 * case publishes a NEW `DatasetVersion` that copies the current version's test
 * cases (new row ids, same stable `testCaseId`) with the change applied, then
 * repoints `Dataset.currentVersionId`. Any run that pinned an older version
 * keeps reading exactly what it ran against.
 *
 * Concurrency: repointing the pointer is a compare-and-swap, not a read-then-write
 * — see the `updateMany` at the end of `publishDatasetVersion`.
 */

/** The persisted fields of a test case, minus row/version identity. */
export type TestCaseSeed = {
  testCaseId: string;
  input: string;
  expected: string | null;
  metadata: unknown;
  review: string;
  captureReason: string;
  sourceTraceId: string | null;
  sourceSpanId: string | null;
  sourceSpanName: string | null;
  sourceSpanKind: string | null;
  /** Eval-result provenance (set when a case is saved from a result). Optional so
   *  non-result cases omit it; `toSeed` carries it across version copies. */
  sourceRunId?: string | null;
  sourceResultId?: string | null;
  addedBy: string | null;
  /**
   * When this case was first created. Carried across version copies so an
   * unchanged case keeps its original "Created" date — publishing a new version
   * (add/edit) must not restamp every row to now. Omitted on a brand-new case,
   * which then defaults to now().
   */
  createTime?: Date;
};

function toSeed(c: TestCase): TestCaseSeed {
  return {
    testCaseId: c.testCaseId,
    input: c.input,
    expected: c.expected,
    metadata: c.metadata ?? null,
    review: c.review,
    captureReason: c.captureReason,
    sourceTraceId: c.sourceTraceId,
    sourceSpanId: c.sourceSpanId,
    sourceSpanName: c.sourceSpanName,
    sourceSpanKind: c.sourceSpanKind,
    sourceRunId: c.sourceRunId,
    sourceResultId: c.sourceResultId,
    addedBy: c.addedBy,
    createTime: c.createTime,
  };
}

/** Deterministic JSON with recursively sorted object keys — so two structurally equal
 *  values compare equal regardless of key order (JSONB round-trips don't preserve it).
 *
 *  Also the canonicalizer for content-addressed case ids (`stableCaseId`): the id
 *  hashes this exact string, so it must match the SDK's `canonicalJson` byte-for-byte
 *  for the inputs the UI actually authors. UI case inputs are always genuine strings
 *  (see `CreateTestCaseRequestSchema.input`), and for a string value this reduces to
 *  `JSON.stringify(value)` in both this helper and the SDK's — so a UI-authored case
 *  and an SDK-authored case for the same input converge on the same `tc_` id. */
export function canonicalJson(v: unknown): string {
  if (typeof v === "string") {
    // A lone UTF-16 surrogate cannot be UTF-8 encoded; the SDK's canonicalizer raises
    // on it, so reject it here too rather than silently hashing JS's escaped form and
    // diverging cross-SDK. (The reachable id path is always a string value.)
    rejectLoneSurrogate(v);
    return JSON.stringify(v);
  }
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort(compareCodePoints)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Order strings by Unicode code POINT (Python `sorted()` order), not by UTF-16 code
 *  unit (JS default `.sort()`); they differ only when an astral-plane character meets a
 *  BMP one in U+E000..U+FFFF. Keeps object-key order byte-parity with the SDK canonicalizer. */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx - cy;
  }
}

/** A stable signature of a version's semantic CONTENT — the per-case (id, input, expected,
 *  metadata), order-independent. Capture provenance (source fields, review, addedBy,
 *  createTime) is NOT content, so it never forks a version. Identical content shares one.
 *
 *  input/expected are DECODED before canonicalization (they are stored as JSON-encoded
 *  strings): otherwise two byte-different encodings of the same value — e.g. reordered
 *  object keys `{"a":1,"b":2}` vs `{"b":2,"a":1}` — would sign differently and spuriously
 *  fork a version / break content-addressed dedup, the same way metadata already canonicalizes. */
export function contentSignature(seeds: TestCaseSeed[]): string {
  const rows = seeds
    .map((s) => ({
      id: s.testCaseId,
      input: decodeJsonValue(s.input),
      expected: s.expected == null ? null : decodeJsonValue(s.expected),
      metadata: s.metadata ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson(rows);
}

/**
 * Publish a new version by transforming the current version's cases. `transform`
 * receives the current seeds and returns the full set for the new version, plus
 * which testCaseId to report back as the focus of the change.
 *
 * Runs in one interactive transaction so a version + its cases + the current
 * pointer move together.
 */
export async function publishDatasetVersion(opts: {
  /** Server-side dataset id (session/UI routes). */
  datasetId?: string;
  /** SDK-chosen, project-scoped id (public routes) — resolved via resolvePublicDataset. */
  clientDatasetId?: string;
  projectId: string;
  note?: string | null;
  createdBy?: string | null;
  /** Optional custom version label; defaults to `v<number>`. */
  label?: string;
  /**
   * Optimistic concurrency: the version this edit was based on. When provided
   * (including explicit null for "no version yet"), a mismatch with the dataset's
   * current version throws VersionConflict. Omit entirely to skip the check
   * (the session UI routes, which always edit the live current version).
   */
  baseVersionId?: string | null;
  /**
   * Idempotency: a retried publish with the same key returns the version already
   * published for it instead of creating a duplicate. Stored on the version.
   */
  idempotencyKey?: string | null;
  transform: (current: TestCaseSeed[]) => { cases: TestCaseSeed[]; focusTestCaseId: string };
}): Promise<{
  datasetId: string;
  versionId: string;
  versionNumber: number;
  focusTestCaseId: string;
  caseCount: number;
  replayed: boolean;
}> {
  return prisma.$transaction(async (tx) => {
    const dataset =
      opts.clientDatasetId !== undefined
        ? await resolvePublicDataset(tx, opts.projectId, opts.clientDatasetId)
        : opts.datasetId
          ? await tx.dataset.findFirst({
              where: { id: opts.datasetId, projectId: opts.projectId },
              select: { id: true, currentVersionId: true },
            })
          : (() => {
              throw new Error("publishDatasetVersion needs a datasetId or a clientDatasetId");
            })();
    if (!dataset) throw new DatasetNotFound();
    const datasetId = dataset.id;

    // Idempotent replay: a publish already recorded for this key wins over the
    // conflict check below, so a network retry after success returns that version.
    if (opts.idempotencyKey) {
      const prior = await tx.datasetVersion.findFirst({
        where: { datasetId, idempotencyKey: opts.idempotencyKey },
        select: { id: true, versionNumber: true },
      });
      if (prior) {
        return {
          datasetId,
          versionId: prior.id,
          versionNumber: prior.versionNumber,
          focusTestCaseId: "",
          caseCount: await tx.testCase.count({ where: { datasetVersionId: prior.id } }),
          replayed: true,
        };
      }
    }

    // Optimistic concurrency applies only to an EXPLICIT base — a UI edit naming the version
    // it was based on. A `null` base is the SDK's "content-addressed upsert" (handled after
    // the transform below); an omitted base is the session UI editing the live current version.
    if (typeof opts.baseVersionId === "string") {
      const currentId = dataset.currentVersionId ?? null;
      if (currentId !== opts.baseVersionId) {
        throw new VersionConflict(currentId);
      }
    }

    const current = dataset.currentVersionId
      ? await tx.testCase.findMany({
          where: { datasetVersionId: dataset.currentVersionId },
          orderBy: TEST_CASE_ORDER,
        })
      : [];

    const currentSeeds = current.map(toSeed);
    const { cases, focusTestCaseId } = opts.transform(currentSeeds);

    // Content-addressed upsert (SDK, base === null): a re-publish with byte-identical content
    // resolves to the SAME version instead of forking one — so repeated runs of a dataset stay
    // on one version and compare cleanly — while a genuine content change appends a new version
    // (versioning IS how changed content is handled). Only a null base opts in; an explicit base
    // already passed its concurrency check, and an omitted base is a live session edit.
    if (
      opts.baseVersionId === null &&
      dataset.currentVersionId &&
      contentSignature(currentSeeds) === contentSignature(cases)
    ) {
      const cur = await tx.datasetVersion.findUnique({
        where: { id: dataset.currentVersionId },
        select: { versionNumber: true },
      });
      return {
        datasetId,
        versionId: dataset.currentVersionId,
        versionNumber: cur?.versionNumber ?? 0,
        focusTestCaseId,
        caseCount: current.length,
        replayed: true,
      };
    }

    const last = await tx.datasetVersion.findFirst({
      where: { datasetId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const versionNumber = (last?.versionNumber ?? 0) + 1;

    // The version id is a time-sortable snowflake generated here — it IS the value the
    // UI and SDK see (it replaced the cuid PK). It encodes (createMs, versionNumber), so
    // it is unique within a dataset by versionNumber; a clash is only possible across
    // datasets minting the same versionNumber in the same millisecond, so nudge the ms
    // until the id is free and store that same ms as createTime (keeping the two in sync).
    let createMs = Date.now();
    let id = versionSnowflakeFromMs(createMs, versionNumber);
    for (
      let i = 0;
      i < 100 && (await tx.datasetVersion.findUnique({ where: { id }, select: { id: true } }));
      i++
    ) {
      createMs += 1;
      id = versionSnowflakeFromMs(createMs, versionNumber);
    }

    const version = await tx.datasetVersion.create({
      data: {
        id,
        datasetId,
        projectId: opts.projectId,
        versionNumber,
        label: opts.label ?? `v${versionNumber}`,
        note: opts.note ?? null,
        createdBy: opts.createdBy ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        createTime: new Date(createMs),
      },
    });

    if (cases.length > 0) {
      await tx.testCase.createMany({
        data: cases.map(({ createTime, ...c }) => ({
          ...c,
          metadata: (c.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          // Preserve an existing case's original created date across the copy; a
          // brand-new case (no createTime on the seed) omits it and defaults to now.
          ...(createTime ? { createTime } : {}),
          datasetVersionId: version.id,
          datasetId,
          projectId: opts.projectId,
        })),
      });
    }

    // Compare-and-swap, not a plain write: Postgres runs this transaction at READ
    // COMMITTED with no lock on the dataset row, so two publishes that both read
    // `currentVersionId = dataset.currentVersionId` above would otherwise both
    // reach an unconditional update and race — the loser's version would be
    // created and left the dataset's current pointer, with nothing to signal that
    // its base was stale. Gating the write on the pointer still being what this
    // publish read turns that race into a deliberate conflict instead.
    const moved = await tx.dataset.updateMany({
      where: {
        id: datasetId,
        projectId: opts.projectId,
        currentVersionId: dataset.currentVersionId,
      },
      data: { currentVersionId: version.id },
    });
    if (moved.count === 0) {
      const now = await tx.dataset.findFirst({
        where: { id: datasetId },
        select: { currentVersionId: true },
      });
      // Rolls the whole transaction back, so the losing version is never persisted.
      throw new VersionConflict(now?.currentVersionId ?? null);
    }

    return {
      datasetId,
      versionId: version.id,
      versionNumber,
      focusTestCaseId,
      caseCount: cases.length,
      replayed: false,
    };
  });
}

type DatasetReader = Pick<Prisma.TransactionClient, "dataset">;

/**
 * Resolve the id an SDK addresses a dataset by, always within the caller's project.
 *
 * Preference order is the project-scoped `clientDatasetId`, then the row id — the
 * fallback keeps datasets created in the UI (which have no client id) addressable,
 * without putting SDK-chosen ids back into a global keyspace where one tenant could
 * squat another's names.
 */
export async function resolvePublicDataset(tx: DatasetReader, projectId: string, ref: string) {
  const byClientId = await tx.dataset.findUnique({
    where: { projectId_clientDatasetId: { projectId, clientDatasetId: ref } },
  });
  if (byClientId) return byClientId;
  return tx.dataset.findFirst({ where: { id: ref, projectId } });
}

export class DatasetNotFound extends Error {
  constructor() {
    super("Dataset not found");
    this.name = "DatasetNotFound";
  }
}

/** Thrown when a publish's base version isn't the dataset's live version (A4 → 409). */
export class VersionConflict extends Error {
  constructor(public readonly currentVersionId: string | null) {
    super("Dataset version conflict");
    this.name = "VersionConflict";
  }
}
