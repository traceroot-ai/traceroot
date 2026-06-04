/**
 * Pure policy for the span I/O renderer.
 *
 * Long string values are truncated to a bounded prefix by default (revealed
 * behind a "show more" toggle). Nested objects/arrays are expanded by default
 * at shallow depths / small sizes, and collapsed (rendered as `{ N items }`)
 * once a node is deep or large. Together these keep a large (~300 KB)
 * input/output blob from rendering thousands of expanded DOM nodes up front —
 * what janks the main thread when a span is selected — while keeping a normal
 * span's I/O readable on first paint without a click.
 *
 * (A future change will window very large expanded structures with
 * virtualization; until then the size guards below bound the up-front cost.)
 *
 * Kept JSX-free so the policy can be unit-tested without a DOM environment.
 */

/** Long string values are truncated to this many characters by default. */
export const STRING_TRUNCATE_AT = 500;

/** Deepest level expanded by default; deeper nodes start collapsed. */
export const AUTO_EXPAND_MAX_DEPTH = 8;

/** A nested node expands by default only if it has at most this many entries. */
export const AUTO_EXPAND_MAX_ITEMS = 20;

/** The root node is allowed to expand with more entries than a nested one. */
export const AUTO_EXPAND_MAX_ITEMS_ROOT = 100;

/** Whether a string value is long enough to be truncated by default. */
export function shouldTruncate(value: string): boolean {
  return value.length > STRING_TRUNCATE_AT;
}

/** The leading portion of a string shown while collapsed. */
export function truncateString(value: string): string {
  return value.length > STRING_TRUNCATE_AT ? value.slice(0, STRING_TRUNCATE_AT) : value;
}

/**
 * Whether an object/array node should render expanded by default.
 *
 * "Smart expansion": shallow, small nodes open on first paint so a normal
 * span's I/O is readable without a click, while deep or large nodes stay
 * collapsed so a huge blob can't flood the DOM up front. The root
 * (`depth === 0`) gets a higher entry budget since it's the one node the user
 * always wants to see.
 */
export function shouldAutoExpand(depth: number, count: number): boolean {
  if (depth > AUTO_EXPAND_MAX_DEPTH) {
    return false;
  }
  const maxItems = depth === 0 ? AUTO_EXPAND_MAX_ITEMS_ROOT : AUTO_EXPAND_MAX_ITEMS;
  return count <= maxItems;
}
