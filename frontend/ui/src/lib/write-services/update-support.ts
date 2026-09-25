/**
 * Shared pieces of the update and delete services: the diff that decides
 * whether anything is written, and the delete reason every surface must carry.
 */

export const NO_FIELDS_MESSAGE = "No fields to update";

export const DELETE_REASON_MIN = 3;
export const DELETE_REASON_MAX = 500;
export const DELETE_REASON_MESSAGE = `reason must be a string of ${DELETE_REASON_MIN} to ${DELETE_REASON_MAX} characters`;

/**
 * The reason a delete records, checked here rather than only at a route so a
 * caller reaching the service directly still has to state one. Stored as
 * given; the bounds are on the trimmed text so whitespace cannot stand in for
 * a reason.
 */
export function validateDeleteReason(
  reason: unknown,
): { ok: true; reason: string } | { ok: false; status: 400; error: string } {
  if (typeof reason !== "string") return { ok: false, status: 400, error: DELETE_REASON_MESSAGE };
  const length = reason.trim().length;
  if (length < DELETE_REASON_MIN || length > DELETE_REASON_MAX) {
    return { ok: false, status: 400, error: DELETE_REASON_MESSAGE };
  }
  return { ok: true, reason };
}

/** The field names a patch actually carries: absent and undefined are the same "untouched". */
export function definedKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => patch[key] !== undefined);
}

/** `sampleRate` -> `sample_rate`: the name the public API uses for the field. */
export function toPublicField(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Structural equality for JSON values. Key order is deliberately ignored:
 * jsonb columns store object keys in their own order, so a stored spec and
 * the same spec freshly parsed would otherwise never compare equal.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && jsonEqual(left[key], right[key]));
}

/**
 * The part of a patch that would change anything: `data` holds only the
 * carried fields whose value differs from the stored one (the write), and
 * `changed` names them in public form (the answer). `current` carries the
 * stored values under the patch's own keys, already in the form the patch is
 * compared in (canonical filters, numbers for decimals), so the diff is one
 * rule for every resource.
 */
export function diffPatch<P extends Record<string, unknown>>(
  patch: P,
  current: object,
): { changed: string[]; data: Partial<P> } {
  const stored = current as Record<string, unknown>;
  const data: Partial<P> = {};
  for (const key of definedKeys(patch)) {
    if (!jsonEqual(patch[key], stored[key])) data[key as keyof P] = patch[key] as P[keyof P];
  }
  return { changed: Object.keys(data).map(toPublicField), data };
}
