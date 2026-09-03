import { isValidPredicate, MAX_FILTERS } from "@/features/filters/predicate";
import { STATIC_FILTER_FIELDS, type FilterFieldDef } from "@/features/filters/registry";
import type { Predicate } from "@/types/api";

// The renderer shows this many rows when the spec leaves limit out; parsing
// fills it in so a stored spec always says what it renders.
export const TRACE_FEED_DEFAULT_LIMIT = 10;
// Mirrors the trace-list endpoint's page-size bound: the feed passes limit
// straight into the trace-list query, so a larger value would 422 every render.
export const TRACE_FEED_LIMIT_MAX = 200;

export interface TraceFeedSpec {
  filters: Predicate[];
  limit: number;
}

export type TraceFeedSpecResult = { ok: true; data: TraceFeedSpec } | { ok: false; error: string };

// Registry rows keyed by field name. A Map rather than an object literal because the
// lookup key is model- or user-supplied: an object index would resolve inherited names
// like `__proto__` or `toString` to something truthy and admit a field the backend has
// no column for.
const FIELD_DEFS = new Map<string, FilterFieldDef>(STATIC_FILTER_FIELDS.map((f) => [f.field, f]));

/**
 * Check one predicate against its registry row: the field must be a real filter column,
 * the operator must be one that column accepts, and a numeric column's value must be a
 * number (a whole one where the column is integer-typed). The shape guard alone lets
 * through combinations the query engine rejects -- `errors contains "x"`, `cost = "1.5"`,
 * or a field name that has no column at all -- which would store a widget that 422s on
 * every render. Returns the problem for the caller to prefix with the filter index.
 */
function predicateRegistryError(p: Predicate): string | null {
  const def = FIELD_DEFS.get(p.field);
  if (!def) return `names unknown field "${p.field}"`;
  if (!def.operators.includes(p.op)) return `does not accept op "${p.op}" on field "${p.field}"`;
  // Only numeric columns constrain the value type beyond the shape guard: `eq` accepts a
  // string there, which the numeric comparison in the query engine cannot use.
  if (def.type === "numeric") {
    if (typeof p.value !== "number") return `needs a number for field "${p.field}"`;
    // Every filterable metric column is non-negative, so a negative bound binds to
    // nothing: the widget stores fine and then 422s on every render. The query
    // translator rejects it at read time; rejecting it here is what keeps it from
    // being stored. (Non-finite values never reach this — the shape guard above
    // already requires a finite number for every numeric operator.)
    if (p.value < 0) return `needs a non-negative number for field "${p.field}"`;
    if (def.integer && !Number.isInteger(p.value)) {
      return `needs a whole number for field "${p.field}"`;
    }
  }
  return null;
}

/**
 * Validate a trace_feed widget spec (the trace-list predicate wire format)
 * with the same predicate shape-guard the feed renderer uses, plus a check of
 * every predicate against the filter registry, so a widget can't be stored that
 * the renderer would silently drop filters from or that names a column/operator
 * combination the query engine rejects. Returns the parsed shape (defaults
 * filled) on success.
 *
 * Unknown keys are rejected rather than stripped: both feed fields are
 * optional, so without this a spec in a different dialect entirely (e.g. a
 * query chart spec) would "validate" as an empty feed instead of failing.
 */
export function parseTraceFeedSpec(spec: Record<string, unknown>): TraceFeedSpecResult {
  const unexpected = Object.keys(spec).find((key) => key !== "filters" && key !== "limit");
  if (unexpected !== undefined) {
    return { ok: false, error: `unexpected key "${unexpected}"` };
  }
  const filters = spec.filters ?? [];
  if (!Array.isArray(filters)) {
    return { ok: false, error: "filters must be an array of trace filter predicates" };
  }
  if (filters.length > MAX_FILTERS) {
    return { ok: false, error: `filters must contain at most ${MAX_FILTERS} predicates` };
  }
  for (let i = 0; i < filters.length; i++) {
    const predicate: unknown = filters[i];
    if (!isValidPredicate(predicate)) {
      return { ok: false, error: `filters[${i}] is not a valid trace filter predicate` };
    }
    const registryError = predicateRegistryError(predicate);
    if (registryError) {
      return { ok: false, error: `filters[${i}] ${registryError}` };
    }
  }
  const limit = spec.limit ?? TRACE_FEED_DEFAULT_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > TRACE_FEED_LIMIT_MAX
  ) {
    return { ok: false, error: `limit must be an integer between 1 and ${TRACE_FEED_LIMIT_MAX}` };
  }
  return { ok: true, data: { filters: filters as Predicate[], limit } };
}
