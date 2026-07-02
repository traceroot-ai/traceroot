/**
 * Pure helpers for the trace-list filter predicate IR (`{field, op, value}`).
 *
 * Kept framework-free so the canonicalization, URL serialization, and validation
 * are unit-testable without React or the DOM, and reused by both the query-key
 * builder and the URL-synced state hook.
 */
import type { Predicate } from "@/types/api";

const VALID_OPS = new Set<Predicate["op"]>(["in", "between"]);

/** Shape-guard for a single predicate parsed from untrusted input (e.g. a URL). */
export function isValidPredicate(p: unknown): p is Predicate {
  if (typeof p !== "object" || p === null) return false;
  const { field, op, value } = p as Record<string, unknown>;
  if (typeof field !== "string" || !VALID_OPS.has(op as Predicate["op"])) return false;
  if (op === "in") {
    // Non-empty: an empty `in` matches nothing and the backend 422s it, so a
    // hand-edited/degenerate empty-`in` is dropped here rather than sinking the fetch.
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
  }
  // between: exactly two bounds, each a FINITE number or null (nullable open range).
  // Number.isFinite rejects Infinity/NaN — e.g. a hand-edited `1e999` parses to Infinity,
  // which JSON.stringify would silently coerce to null (corrupting the key/payload).
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => v === null || Number.isFinite(v))
  );
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
      // agree on the same cache entry. `between` bounds are positional; leave them.
      const value = p.op === "in" && Array.isArray(p.value) ? [...p.value].sort() : p.value;
      return JSON.stringify({ field: p.field, op: p.op, value });
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
