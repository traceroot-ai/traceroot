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
  transform: (current: TestCaseSeed[]) => { cases: TestCaseSeed[]; focusTestCaseId: string };
}): Promise<{ versionId: string; versionNumber: number; focusTestCaseId: string }> {
  return prisma.$transaction(async (tx) => {
    const dataset = await tx.dataset.findFirst({
      where: { id: opts.datasetId, projectId: opts.projectId },
      select: { id: true, currentVersionId: true },
    });
    if (!dataset) throw new DatasetNotFound();

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
        label: `v${versionNumber}`,
        note: opts.note ?? null,
        createdBy: opts.createdBy ?? null,
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

    await tx.dataset.update({
      where: { id: opts.datasetId },
      data: { currentVersionId: version.id },
    });

    return { versionId: version.id, versionNumber, focusTestCaseId };
  });
}

export class DatasetNotFound extends Error {
  constructor() {
    super("Dataset not found");
    this.name = "DatasetNotFound";
  }
}
