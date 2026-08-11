/**
 * Pure helpers for the trace-list filter predicate IR (`{field, key?, op, value}`).
 *
 * Kept framework-free so the canonicalization, URL serialization, and validation
 * are unit-testable without React or the DOM, and reused by both the query-key
 * builder and the URL-synced state hook.
 */
import type { Predicate } from "@/types/api";
import { STATIC_FILTER_FIELDS } from "./registry";

const VALID_OPS = new Set<Predicate["op"]>(["in", "eq", "gt", "gte", "lt", "lte", "contains"]);

// Fields whose predicate carries a key slot. Read off the static registry rather than
// hard-coded so `requires_key` has one frontend source of truth; the live `/filter-fields`
// payload can't serve here because URL predicates are validated before any fetch resolves.
const KEY_REQUIRED_FIELDS = new Set(
  STATIC_FILTER_FIELDS.filter((f) => f.requires_key).map((f) => f.field),
);

// Mirrors MAX_KEY_LENGTH in backend/rest/services/filters/translate.py. Rejecting here
// keeps an over-long key out of state entirely: admitted, it would persist to the URL and
// to storage and then 422 every list request until the user found and removed it by hand.
export const MAX_KEY_LENGTH = 256;

/** Shape-guard for a single predicate parsed from untrusted input (e.g. a URL). */
export function isValidPredicate(p: unknown): p is Predicate {
  if (typeof p !== "object" || p === null) return false;
  const { field, key, op, value } = p as Record<string, unknown>;
  if (typeof field !== "string" || !VALID_OPS.has(op as Predicate["op"])) return false;
  // A keyed field needs a non-empty key, and every other field must carry none. Rejecting a
  // stray key rather than ignoring it keeps the chip, the URL, and the query the backend runs
  // describing the same filter. Any key VALUE is legal: it binds as a parameter, so an
  // unrecognized key is an empty result, never a rejection.
  if (KEY_REQUIRED_FIELDS.has(field)) {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  } else if (key !== undefined) {
    return false;
  }
  if (op === "in") {
    // Non-empty list of strings: an empty `in` matches nothing and the backend 422s it,
    // so a hand-edited/degenerate empty-`in` is dropped here rather than sinking the fetch.
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
  }
  if (op === "contains") {
    return typeof value === "string" && value.length > 0;
  }
  if (op === "eq") {
    // Numeric equality OR a text exact match — a finite number or a non-empty string.
    return (
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 0)
    );
  }
  // gt/gte/lt/lte: a single FINITE number. Number.isFinite rejects Infinity/NaN — e.g. a
  // hand-edited `1e999` parses to Infinity, which JSON.stringify would coerce to null.
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A deterministic string key for a set of filters that is independent of predicate
 * order, so two arrays differing only in order fold to one React Query cache entry
 * (otherwise hover-prefetch and the list hook would key differently and miss).
 */
export function canonicalizeFilters(filters?: Predicate[]): string {
  if (!filters || filters.length === 0) return "";
  return filters
    .map((p) => {
      // Sort the `in` values so ["a","b"] and ["b","a"] fold to one key — the set of
      // matched values is order-independent, so hover-prefetch and the list hook must
      // agree on the same cache entry. Scalar values (numbers/strings) are left as-is.
      const value = p.op === "in" && Array.isArray(p.value) ? [...p.value].sort() : p.value;
      // The key is part of a keyed predicate's identity: `metadata[session_id] = x` and
      // `metadata[user_id] = x` select different traces. An absent key stringifies away,
      // so keyless predicates keep the shape their cache entries were written under.
      return JSON.stringify({ field: p.field, key: p.key, op: p.op, value });
    })
    .sort()
    .join("|");
}

/**
 * Serialize filters for the `?filters=` URL param; null when there is nothing to add.
 * Drops invalid predicates on the way out (symmetric with `parseFiltersParam` on the way
 * in), so a malformed shape — e.g. an empty `in` — can't reach the URL/backend and 422.
 */
export function serializeFiltersParam(filters?: Predicate[]): string | null {
  const valid = (filters ?? []).filter(isValidPredicate);
  return valid.length === 0 ? null : JSON.stringify(valid);
}

/**
 * Parse the `?filters=` param into validated predicates. Defensive against
 * hand-edited URLs: malformed JSON or a non-array yields `[]`, and individual
 * predicates that fail the shape guard are dropped rather than poisoning the list.
 */
export function parseFiltersParam(raw: string | null): Predicate[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidPredicate);
}
