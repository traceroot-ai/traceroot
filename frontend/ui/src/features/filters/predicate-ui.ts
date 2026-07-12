/**
 * Builder-side predicate helpers for the filter UI: rendering a predicate
 * as a readable chip label, and constructing predicates from raw inputs. Framework-free
 * and unit-tested; kept separate from `predicate.ts` (serialization/canonicalization).
 */
import type { Predicate } from "@/types/api";

/**
 * Human-readable label for an active-filter chip. Mirrors how the predicate reads and
 * matches the backend comparison exactly: a single `in` value shows as `=`, multiple as
 * `in [...]`; numeric `eq/gt/gte/lt/lte` show as `= / > / ≥ / < / ≤`; text `contains`
 * shows as `contains`.
 *
 * `name` is the field's display name (its registry label, lowercased — e.g. `latency`
 * for `duration_ms`); it defaults to the raw field key when a label isn't available.
 */
export function predicateLabel(p: Predicate, name: string = p.field): string {
  switch (p.op) {
    case "in":
      return p.value.length === 1
        ? `${name} = ${p.value[0]}`
        : `${name} in [${p.value.join(", ")}]`;
    case "eq":
      return `${name} = ${p.value}`;
    case "gt":
      return `${name} > ${p.value}`;
    case "gte":
      return `${name} ≥ ${p.value}`;
    case "lt":
      return `${name} < ${p.value}`;
    case "lte":
      return `${name} ≤ ${p.value}`;
    case "contains":
      return `${name} contains ${p.value}`;
  }
}

/** Construct a categorical membership predicate from selected values. */
export function buildInPredicate(field: string, values: string[]): Predicate {
  return { field, op: "in", value: values };
}

/** Construct a numeric comparison predicate (`eq/gt/gte/lt/lte`). */
export function buildNumericPredicate(
  field: string,
  op: "eq" | "gt" | "gte" | "lt" | "lte",
  value: number,
): Predicate {
  return { field, op, value };
}

/** Construct a text predicate: exact `eq` or case-insensitive `contains`. */
export function buildTextPredicate(field: string, op: "eq" | "contains", value: string): Predicate {
  return { field, op, value };
}

// Which "slot" a predicate occupies on its field, so we know what a new predicate
// replaces vs. coexists with. A numeric field can hold at most one lower + one upper
// bound (a range); everything else is single-slot per field.
type Slot = "in" | "exact" | "text" | "lower" | "upper";
function slotOf(p: Predicate): Slot {
  switch (p.op) {
    case "in":
      return "in";
    case "eq":
      return "exact";
    case "contains":
      return "text";
    case "gt":
    case "gte":
      return "lower";
    case "lt":
    case "lte":
      return "upper";
  }
}

/**
 * Add `next` to the active filter set, merging by slot so a numeric range can be built
 * from two one-sided filters: a lower bound (`>`/`≥`) and an upper bound (`<`/`≤`) on the
 * same field coexist (e.g. `latency > 5` AND `latency ≤ 10`, which the backend
 * AND-combines). A categorical value, an exact `=`, a text match, a same-direction bound,
 * or a contradictory opposite bound replaces the matching predicate rather than stacking.
 */
export function upsertPredicate(filters: Predicate[], next: Predicate): Predicate[] {
  const ns = slotOf(next);
  const keep = (e: Predicate): boolean => {
    if (e.field !== next.field) return true;
    // A categorical value, an exact `=`, or a text match supersedes everything on the field.
    if (ns === "in" || ns === "exact" || ns === "text") return false;
    // A new one-sided bound keeps the opposite existing bound ONLY if the two form a
    // non-empty range; a same-direction bound, or a contradictory opposite bound (e.g.
    // errors > 5 then errors < 3, which no value satisfies), is superseded by the new one.
    const es = slotOf(e);
    if (ns === "lower" && es === "upper") return boundsFormRange(next, e);
    if (ns === "upper" && es === "lower") return boundsFormRange(e, next);
    return false;
  };
  return [...filters.filter(keep), next];
}

// Whether a lower bound (`>`/`≥`) and an upper bound (`<`/`≤`) describe a non-empty range.
// Non-empty iff `lo < hi`, or `lo === hi` with BOTH bounds inclusive (`≥ x AND ≤ x`
// matches exactly x). A contradictory pair is dropped; the newer predicate wins instead.
function boundsFormRange(lower: Predicate, upper: Predicate): boolean {
  const lo = numericValue(lower);
  const hi = numericValue(upper);
  if (lo === null || hi === null) return false;
  if (lo < hi) return true;
  return lo === hi && lower.op === "gte" && upper.op === "lte";
}

function numericValue(p: Predicate): number | null {
  return typeof p.value === "number" ? p.value : null;
}
