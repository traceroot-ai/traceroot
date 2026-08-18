import { prisma } from "@traceroot/core";
import {
  publishDatasetVersion,
  canonicalJson,
  DatasetNotFound,
  type TestCaseSeed,
} from "./versions";
import { nextCaseId } from "./case-id";
import { encodeEditedText, decodeJsonValue } from "./json-value";

/**
 * Save an evaluation result into a dataset — the three explicit result-driven
 * actions, built on the immutable versioning engine (`publishDatasetVersion`).
 *
 * Invariants enforced here:
 *  - Candidate output is NEVER used as expected implicitly. `expected` is set only
 *    from an explicit value or an explicit "use candidate as expected" opt-in. The
 *    candidate output isn't stored on the case; the source run/result links preserve
 *    what actually happened (matching the dataset-item model).
 *  - Updating an existing case publishes a new immutable version and preserves the
 *    stable logical `testCaseId`.
 *  - Re-saving a result into its ORIGINATING dataset as a *new* case is refused with
 *    a conflict (→ update instead); only `duplicate_as_variant` opts into a second
 *    logical case.
 *  - Idempotency: a retried request with the same key returns the already-published
 *    version rather than duplicating (delegated to the engine).
 */
export type ResultDatasetAction = "update_existing_case" | "save_new_case" | "duplicate_as_variant";

export class ResultNotFound extends Error {
  constructor() {
    super("Evaluation result not found");
    this.name = "ResultNotFound";
  }
}

/** The result is not backed by a live dataset case, so there is nothing to update. */
export class NoOriginatingCase extends Error {
  constructor() {
    super("This result is not linked to a live dataset test case to update.");
    this.name = "NoOriginatingCase";
  }
}

/** Re-saving a result into its originating dataset would silently duplicate a case. */
export class CircularSaveConflict extends Error {
  constructor(public readonly existingTestCaseId: string) {
    super(
      "This result already maps to a test case in its originating dataset. Use " +
        "update_existing_case, or duplicate_as_variant to intentionally add a second case.",
    );
    this.name = "CircularSaveConflict";
  }
}

export async function saveResultToDataset(opts: {
  projectId: string;
  resultId: string;
  action: ResultDatasetAction;
  /** Target dataset for save/duplicate; ignored for update (uses the originating one). */
  datasetId?: string | null;
  /** `undefined` = omitted (keep current on update / default to the result on new). */
  input?: string | null;
  /** `undefined` = omitted; an explicit `null` clears expected. Never the candidate. */
  expected?: string | null;
  /** Explicit opt-in: set expected = the result's candidate output. */
  useCandidateAsExpected?: boolean;
  /** `undefined` = omitted. */
  metadata?: unknown;
  idempotencyKey?: string | null;
  addedBy?: string | null;
}) {
  const result = await prisma.evaluationResult.findFirst({
    where: { id: opts.resultId, projectId: opts.projectId },
    select: {
      id: true,
      runId: true,
      testCaseId: true,
      traceId: true,
      input: true,
      candidateOutput: true,
    },
  });
  if (!result) throw new ResultNotFound();
  const run = await prisma.evaluationRun.findFirst({
    where: { id: result.runId, projectId: opts.projectId },
    select: { datasetId: true },
  });
  if (!run) throw new ResultNotFound();

  const originatingDatasetId = run.datasetId;
  const inputProvided = opts.input !== undefined;
  const expectedProvided = opts.expected !== undefined;
  const metadataProvided = opts.metadata !== undefined;

  // Never default expected to candidate: only an explicit value or explicit opt-in.
  // Raw sources (candidate output, drawer text) are JSON-ENCODED on write so their
  // type round-trips on pull — matching every other write path (trace-save, editor,
  // public publish). `currentExpected` is already encoded, so it passes through; a
  // null previous makes `encodeEditedText` fall back to encoding the text as-is.
  const resolveExpected = (currentExpected: string | null): string | null => {
    if (opts.useCandidateAsExpected)
      return result.candidateOutput == null
        ? null
        : encodeEditedText(currentExpected, result.candidateOutput);
    if (expectedProvided)
      return opts.expected == null ? null : encodeEditedText(currentExpected, opts.expected);
    return currentExpected;
  };

  // Is the result still backed by a live case in its originating dataset?
  const dataset = await prisma.dataset.findFirst({
    where: { id: originatingDatasetId, projectId: opts.projectId },
    select: { currentVersionId: true },
  });
  const originatingCaseLive =
    dataset?.currentVersionId != null &&
    (await prisma.testCase.findFirst({
      where: { testCaseId: result.testCaseId, datasetVersionId: dataset.currentVersionId },
      select: { testCaseId: true },
    })) !== null;

  if (opts.action === "update_existing_case") {
    if (!originatingCaseLive) throw new NoOriginatingCase();
    return publishDatasetVersion({
      datasetId: originatingDatasetId,
      projectId: opts.projectId,
      createdBy: opts.addedBy ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      transform: (current) => {
        // Update expected/input/metadata only as explicitly supplied; the stable
        // logical testCaseId is preserved, so lineage is unbroken.
        const cases = current.map((c) =>
          c.testCaseId === result.testCaseId
            ? {
                ...c,
                input: inputProvided ? encodeEditedText(c.input, opts.input ?? "") : c.input,
                expected: resolveExpected(c.expected),
                metadata: metadataProvided ? opts.metadata : c.metadata,
              }
            : c,
        );
        return { cases, focusTestCaseId: result.testCaseId };
      },
    });
  }

  // save_new_case / duplicate_as_variant → append a NEW logical case.
  const targetDatasetId = opts.datasetId ?? originatingDatasetId;

  // Circular guard: a plain save back into the originating dataset, where the case
  // still exists, is a duplicate — refuse and direct the client to update instead.
  if (
    opts.action === "save_new_case" &&
    targetDatasetId === originatingDatasetId &&
    originatingCaseLive
  ) {
    throw new CircularSaveConflict(result.testCaseId);
  }

  // The pre-image the case id is hashed from — the target dataset's stable key, which
  // by convention defaults to its display name (the SDK's `key = key ?? name`). Legacy
  // rows with a null key fall back to the name so the derivation still matches an SDK
  // author using the same key. (publishDatasetVersion re-validates the dataset exists.)
  const targetDataset = await prisma.dataset.findFirst({
    where: { id: targetDatasetId, projectId: opts.projectId },
    select: { key: true, name: true },
  });
  // Fail fast rather than fabricating a key from the id: a made-up key would hash a
  // `tc_` id no SDK author could reproduce. (publishDatasetVersion re-validates too.)
  if (!targetDataset) throw new DatasetNotFound();
  const targetDatasetKey = targetDataset.key ?? targetDataset.name;

  const newSeedBase: Omit<TestCaseSeed, "testCaseId"> = {
    // No prior stored value, so encode the raw text as-is (a JSON-looking string like
    // "42" stays the string "42" instead of decoding to the number 42 on pull).
    input: encodeEditedText(null, inputProvided ? (opts.input ?? "") : result.input),
    // A brand-new case: expected defaults to null (never the candidate) unless set.
    expected: resolveExpected(null),
    metadata: metadataProvided ? opts.metadata : null,
    review: "needs_review",
    captureReason: "manual",
    sourceTraceId: result.traceId ?? null,
    sourceSpanId: null,
    sourceSpanName: null,
    sourceSpanKind: null,
    sourceRunId: result.runId,
    sourceResultId: result.id,
    addedBy: opts.addedBy ?? null,
  };
  // Canonical-JSON of the case's input, computed on the DECODED value — what the id is
  // hashed from, matching an SDK author (whose SDK canonicalizes the native input) and
  // the occurrence comparison against existing cases below.
  const canonicalInput = canonicalJson(decodeJsonValue(newSeedBase.input));

  return publishDatasetVersion({
    datasetId: targetDatasetId,
    projectId: opts.projectId,
    createdBy: opts.addedBy ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    transform: (current) => {
      // CONTENT-addressed id (parity with the SDK's `stableCaseId`): the same input saved
      // here and pushed from the SDK under the same dataset key converge on one `tc_` id,
      // so re-publishing matches (upsert on id) instead of duplicating. `occurrence` is the
      // first slot whose id is still free, mirroring the SDK so a gap left by a delete
      // never re-mints a live id.
      const existingIds = new Set(current.map((s) => s.testCaseId));
      const { testCaseId } = nextCaseId(existingIds, targetDatasetKey, canonicalInput);
      const newSeed: TestCaseSeed = { testCaseId, ...newSeedBase };
      return { cases: [...current, newSeed], focusTestCaseId: testCaseId };
    },
  });
}
