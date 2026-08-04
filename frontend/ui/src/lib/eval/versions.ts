import { prisma, type Prisma, type TestCase } from "@traceroot/core";
import { randomUUID } from "crypto";

/**
 * Dataset-version publishing — the immutability core.
 *
 * A dataset never mutates its historical snapshots. Adding or editing a test
 * case publishes a NEW `DatasetVersion` that copies the current version's test
 * cases (new row ids, same stable `testCaseId`) with the change applied, then
 * repoints `Dataset.currentVersionId`. Any run that pinned an older version
 * keeps reading exactly what it ran against.
 */

/** The persisted fields of a test case, minus row/version identity. */
export type TestCaseSeed = {
  testCaseId: string;
  input: string;
  expected: string | null;
  recordedOutput: string | null;
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
    recordedOutput: c.recordedOutput,
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

export function newTestCaseId(): string {
  return `tc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
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
  datasetId: string;
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
  versionId: string;
  versionNumber: number;
  focusTestCaseId: string;
  caseCount: number;
  replayed: boolean;
}> {
  return prisma.$transaction(async (tx) => {
    const dataset = await tx.dataset.findFirst({
      where: { id: opts.datasetId, projectId: opts.projectId },
      select: { id: true, currentVersionId: true },
    });
    if (!dataset) throw new DatasetNotFound();

    // Idempotent replay: a publish already recorded for this key wins over the
    // conflict check below, so a network retry after success returns that version.
    if (opts.idempotencyKey) {
      const prior = await tx.datasetVersion.findFirst({
        where: { datasetId: opts.datasetId, idempotencyKey: opts.idempotencyKey },
        select: { id: true, versionNumber: true },
      });
      if (prior) {
        return {
          versionId: prior.id,
          versionNumber: prior.versionNumber,
          focusTestCaseId: "",
          caseCount: await tx.testCase.count({ where: { datasetVersionId: prior.id } }),
          replayed: true,
        };
      }
    }

    // Optimistic concurrency: reject when the caller's base is not the live version.
    if (opts.baseVersionId !== undefined) {
      const currentId = dataset.currentVersionId ?? null;
      if (currentId !== (opts.baseVersionId ?? null)) {
        throw new VersionConflict(currentId);
      }
    }

    const current = dataset.currentVersionId
      ? await tx.testCase.findMany({
          where: { datasetVersionId: dataset.currentVersionId },
          orderBy: { createTime: "asc" },
        })
      : [];

    const { cases, focusTestCaseId } = opts.transform(current.map(toSeed));

    const last = await tx.datasetVersion.findFirst({
      where: { datasetId: opts.datasetId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const versionNumber = (last?.versionNumber ?? 0) + 1;

    const version = await tx.datasetVersion.create({
      data: {
        datasetId: opts.datasetId,
        projectId: opts.projectId,
        versionNumber,
        label: opts.label ?? `v${versionNumber}`,
        note: opts.note ?? null,
        createdBy: opts.createdBy ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
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
          datasetId: opts.datasetId,
          projectId: opts.projectId,
        })),
      });
    }

    // Conditional pointer move: repoint only if `currentVersionId` is still what we
    // read at the top of this transaction. Under READ COMMITTED two concurrent
    // publishes can both clear the `baseVersionId` check above and then both write
    // here, silently dropping one update. Gating the write on the observed value makes
    // the loser match zero rows, which we surface as a VersionConflict to retry —
    // never a lost publish.
    const moved = await tx.dataset.updateMany({
      where: { id: opts.datasetId, currentVersionId: dataset.currentVersionId },
      data: { currentVersionId: version.id },
    });
    if (moved.count === 0) {
      throw new VersionConflict(dataset.currentVersionId ?? null);
    }

    return {
      versionId: version.id,
      versionNumber,
      focusTestCaseId,
      caseCount: cases.length,
      replayed: false,
    };
  });
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
