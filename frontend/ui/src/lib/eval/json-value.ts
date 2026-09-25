/**
 * Canonical representation for dataset test-case `input` / `expected` values.
 *
 * The public dataset API transports these as NATIVE JSON values — objects, arrays,
 * numbers, booleans, null, and genuine strings (including strings that happen to
 * look like JSON, e.g. `"123"` or `"true"`). The database column stays text for now,
 * so a value is stored JSON-ENCODED: encoding a genuine string quotes it (`"123"`),
 * which is what makes it distinguishable on read from the number `123`.
 *
 * See docs/offline-eval-trace-classification-plan.md (Contract 2). Coordinated with
 * the SDK: `pull_dataset` should treat the returned values as already-native and stop
 * re-decoding strings, otherwise a genuine JSON-looking string would be double-decoded.
 */

/** Encode a native JSON value for text storage so its type round-trips on read. */
export function encodeJsonValue(value: unknown): string {
  // JSON.stringify(undefined) is `undefined`; callers guard undefined separately,
  // but treat it as null defensively so we never store the literal string.
  return JSON.stringify(value ?? null);
}

/**
 * Decode a stored value back to its native JSON form. A legacy row written as plain
 * (non-JSON-encoded) text — or any value that isn't valid JSON — is returned as the
 * raw string, so pre-existing datasets keep working.
 */
export function decodeJsonValue(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Encode text submitted by the UI editor, preserving the kind of the value it edits.
 *
 * The UI edits values as text through `displayJsonValue`, which is lossy: a genuine
 * string renders as-is and a structured value renders as pretty JSON, so the text
 * alone cannot say which it was. Both write paths must nonetheless produce the one
 * on-disk encoding (JSON-encoded), or a value silently changes type inside an
 * immutable snapshot a run scores against. The previous stored value is the missing
 * bit of type information:
 *
 * - the value was a string (or the row is legacy plain text) → the edit is a string,
 *   so the genuine string "123" survives an edit instead of becoming the number 123;
 * - the value was structured/scalar → the UI showed JSON, so parse the text back and
 *   keep its kind, falling back to a string if the user typed something that is not
 *   JSON any more.
 */
export function encodeEditedText(previous: string | null | undefined, text: string): string {
  if (previous === null || previous === undefined) return encodeJsonValue(text);
  if (typeof decodeJsonValue(previous) === "string") return encodeJsonValue(text);
  try {
    return encodeJsonValue(JSON.parse(text));
  } catch {
    return encodeJsonValue(text);
  }
}

/**
 * A human-readable string for a decoded value, for the session/UI surface (which
 * edits values as text): a genuine string shows as-is; structured values show as
 * pretty JSON. Never shows a bare string quoted.
 */
export function displayJsonValue(text: string | null | undefined): string {
  const decoded = decodeJsonValue(text);
  if (decoded === null || decoded === undefined) return "";
  return typeof decoded === "string" ? decoded : JSON.stringify(decoded, null, 2);
}
