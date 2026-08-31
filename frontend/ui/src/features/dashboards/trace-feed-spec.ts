import { isValidPredicate, MAX_FILTERS } from "@/features/filters/predicate";
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

/**
 * Validate a trace_feed widget spec (the trace-list predicate wire format)
 * with the same predicate shape-guard the feed renderer uses, so a widget
 * can't be stored that the renderer would silently drop filters from. Returns
 * the parsed shape (defaults filled) on success.
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
  const invalid = filters.findIndex((predicate) => !isValidPredicate(predicate));
  if (invalid !== -1) {
    return { ok: false, error: `filters[${invalid}] is not a valid trace filter predicate` };
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
