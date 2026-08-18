import { createHash } from "crypto";

/**
 * A lone UTF-16 surrogate: a high surrogate not followed by a low one, or a low
 * one not preceded by a high one. Such a string is not valid Unicode text and
 * cannot be UTF-8 encoded — Python raises while hashing it, so we reject it here
 * too rather than silently hashing Node's replacement form and diverging cross-SDK.
 * Kept byte-identical to the SDK's `rejectLoneSurrogate` (traceroot-ts
 * `src/eval/canonical.ts`, traceroot-py `traceroot/eval/canonical.py`).
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function rejectLoneSurrogate(s: string): void {
  if (LONE_SURROGATE.test(s)) {
    throw new Error(
      "string contains an unpaired UTF-16 surrogate and cannot be canonicalized; " +
        "it is not valid Unicode text",
    );
  }
}

/**
 * Derive a dataset case's stable, CONTENT-addressed id (`tc_…`).
 *
 * MUST stay byte-identical to the SDK derivation (traceroot-ts
 * `src/eval/ids.ts::stableCaseId`, traceroot-py
 * `traceroot/eval/ids.py::stable_case_id`):
 *   `"tc_" + sha256(`${datasetKey}\x00${inputCanonical}\x00${occurrence}`, utf-8).hex[:20]`,
 * lowercase hex, first 20 chars, NUL (`\x00`) separators, occurrence rendered as
 * a base-10 integer.
 *
 * A case's identity is its INPUT content, not its position: re-authoring the same
 * input — in the UI, in TypeScript, or in Python — yields the SAME id, so the
 * platform matches it on re-publish (upsert on id) instead of duplicating it, and
 * inserting/removing/reordering other cases never shifts this case's id.
 * `occurrence` disambiguates duplicate inputs (0 for the first case with a given
 * input, 1 for the next, ...). `inputCanonical` is the canonical-JSON of the input
 * (recursively sorted keys); the caller must produce it with the SAME canonicalizer
 * the SDK uses so the pre-image — and therefore the id — is byte-for-byte identical.
 */
export function stableCaseId(datasetKey: string, inputCanonical: string, occurrence = 0): string {
  // `inputCanonical` already went through canonicalization; the raw `datasetKey` has
  // not, so guard it (parity with the SDK, which would raise UTF-8-encoding it).
  rejectLoneSurrogate(datasetKey);
  const digest = createHash("sha256")
    .update(`${datasetKey}\x00${inputCanonical}\x00${occurrence}`, "utf8")
    .digest("hex");
  return `tc_${digest.slice(0, 20)}`;
}

/**
 * Pick the content-addressed id for a NEW case with the given canonical input: the
 * first `occurrence` whose id is not already present in `existingIds` (the ids of the
 * cases already in the version). This mirrors the SDK's `Dataset._content_id` probe
 * (`occurrence = 0; while cid in cases: occurrence += 1`), so it is robust to gaps
 * left by deletes and never collides with a legacy random id — the same input placed
 * in the same version by the UI, TypeScript, or Python lands in the same slot.
 *
 * A plain count of same-input cases only equals this when the existing occurrences
 * are a contiguous `0..n-1` range; a delete leaves a gap, and a count would then
 * re-mint an id that is already taken.
 */
export function nextCaseId(
  existingIds: Set<string>,
  datasetKey: string,
  inputCanonical: string,
): { testCaseId: string; occurrence: number } {
  let occurrence = 0;
  let testCaseId = stableCaseId(datasetKey, inputCanonical, occurrence);
  while (existingIds.has(testCaseId)) {
    occurrence += 1;
    testCaseId = stableCaseId(datasetKey, inputCanonical, occurrence);
  }
  return { testCaseId, occurrence };
}
