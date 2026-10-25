/**
 * Canonical JSON — the deterministic serialization the platform hashes and compares by.
 *
 * A LEAF module on purpose: `versions.ts` (where this used to live) imports `prisma`, and
 * `case-id.ts` imports `crypto`, so neither can be pulled into a `"use client"` bundle.
 * The dataset editors need canonical equality on the client — a metadata reformat must not
 * read as an edit — so the canonicalizer sits here, importing nothing. Mirrors the SDK's
 * own layout (traceroot-ts `src/eval/canonical.ts`, traceroot-py `traceroot/eval/canonical.py`).
 */

/**
 * A lone UTF-16 surrogate: a high surrogate not followed by a low one, or a low
 * one not preceded by a high one. Such a string is not valid Unicode text and
 * cannot be UTF-8 encoded — Python raises while hashing it, so we reject it here
 * too rather than silently hashing Node's replacement form and diverging cross-SDK.
 * Kept byte-identical to the SDK's `rejectLoneSurrogate` (traceroot-ts
 * `src/eval/canonical.ts`, traceroot-py `traceroot/eval/canonical.py`).
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Raised when a string carries an unpaired UTF-16 surrogate and so cannot be
 * canonicalized (it is not valid Unicode text). A dedicated type so callers can tell
 * this specific, caller-fixable condition apart from an unexpected failure — the
 * publish routes map it to a 400, and `contentSignature` swallows it for ALREADY-stored
 * content (which must keep a stable signature rather than be re-validated on every publish).
 */
export class LoneSurrogateError extends Error {
  constructor(
    message = "string contains an unpaired UTF-16 surrogate and cannot be canonicalized; " +
      "it is not valid Unicode text",
  ) {
    super(message);
    this.name = "LoneSurrogateError";
  }
}

export function rejectLoneSurrogate(s: string): void {
  if (LONE_SURROGATE.test(s)) {
    throw new LoneSurrogateError();
  }
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
    .map((k) => {
      // Guard object KEYS too, not just string VALUES: a lone surrogate in an
      // SDK-authored metadata key must reject here rather than silently hashing JS's
      // escaped form and diverging from the SDK's byte-for-byte pre-image.
      rejectLoneSurrogate(k);
      return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
    })
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
