/**
 * Builder-side predicate helpers for the filter UI: rendering a predicate
 * as a readable chip label, and constructing predicates from raw inputs. Framework-free
 * and unit-tested; kept separate from `predicate.ts` (serialization/canonicalization).
 */
import type { Predicate } from "@/types/api";

/**
 * Human-readable label for an active-filter chip. Mirrors how the predicate reads:
 * a single `in` value shows as `=`, multiple as `in [...]`; a `between` with a null
 * bound shows as `≥` (the inclusive "greater than or equal to" bound) or `≤` (the
 * inclusive "less than or equal to" bound); both bounds as `between … and …`.
 *
 * `name` is the field's display name (its registry label, lowercased — e.g. `latency`
 * for `duration_ms`); it defaults to the raw field key when a label isn't available.
 */
export function predicateLabel(p: Predicate, name: string = p.field): string {
  if (p.op === "in") {
    if (p.value.length === 1) return `${name} = ${p.value[0]}`;
    return `${name} in [${p.value.join(", ")}]`;
  }
  const [lo, hi] = p.value;
  if (lo !== null && hi !== null) {
    return lo === hi ? `${name} = ${lo}` : `${name} between ${lo} and ${hi}`;
  }
  if (lo !== null) return `${name} ≥ ${lo}`;
  if (hi !== null) return `${name} ≤ ${hi}`;
  return name;
}

/** Construct a categorical membership predicate from selected values. */
export function buildInPredicate(field: string, values: string[]): Predicate {
  return { field, op: "in", value: values };
}

/** Construct a numeric aggregate predicate; either bound may be null (open range). */
export function buildBetweenPredicate(
  field: string,
  min: number | null,
  max: number | null,
): Predicate {
  return { field, op: "between", value: [min, max] };
}

// Which "slot" a predicate occupies on its field, so we know what a new predicate
// replaces vs. coexists with. A field can hold at most one lower + one upper bound.
type Slot = "in" | "lower" | "upper" | "exact" | "full";
function slotOf(p: Predicate): Slot {
  if (p.op === "in") return "in";
  const [lo, hi] = p.value;
  if (lo !== null && hi !== null) return lo === hi ? "exact" : "full";
  if (lo !== null) return "lower";
  if (hi !== null) return "upper";
  return "full";
}

/**
 * Add `next` to the active filter set, merging by slot so a range can be built from
 * two one-sided filters: a lower bound (`greater than or equal to`) and an upper bound
 * (`less than or equal to`) on the same field coexist (e.g. `latency ≥ 5` AND `latency
 * ≤ 10`, which the backend AND-combines). A same-direction bound, an exact `equals`, a
 * full range, or a categorical value replaces the matching predicate rather than stacking.
 */
export function upsertPredicate(filters: Predicate[], next: Predicate): Predicate[] {
  const ns = slotOf(next);
  const keep = (e: Predicate): boolean => {
    if (e.field !== next.field) return true;
    // A categorical value, an exact point, or a full range supersedes everything on the field.
    if (ns === "in" || ns === "exact" || ns === "full") return false;
    // A new one-sided bound keeps the opposite existing bound ONLY if the two form a
    // non-empty range; a same-direction bound, or a contradictory opposite bound (e.g.
    // errors ≥ 5 then errors ≤ 3, which no value satisfies), is superseded by the
    // just-entered predicate.
    const es = slotOf(e);
    if (ns === "lower" && es === "upper") return boundsFormRange(next, e);
    if (ns === "upper" && es === "lower") return boundsFormRange(e, next);
    return false;
  };
  return [...filters.filter(keep), next];
}

// Whether a lower bound (`[lo, null]`, inclusive `>=`) and an upper bound (`[null, hi]`,
// inclusive `<=`) describe a non-empty range. Both bounds are inclusive, so `lo === hi`
// is a valid one-value range (`>= x AND <= x` matches exactly x) — non-empty iff
// `lo <= hi`. A contradictory pair (`lo > hi`) must not coexist; the newer predicate wins.
function boundsFormRange(lower: Predicate, upper: Predicate): boolean {
  if (lower.op !== "between" || upper.op !== "between") return false;
  const lo = lower.value[0];
  const hi = upper.value[1];
  return lo !== null && hi !== null && lo <= hi;
}
