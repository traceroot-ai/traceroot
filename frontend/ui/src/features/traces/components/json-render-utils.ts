/**
 * Pure truncation policy for the span I/O renderer.
 *
 * Long string values are truncated to a bounded prefix by default (revealed
 * behind a "show more" toggle), and nested objects/arrays start collapsed.
 * Together these keep a large (~300 KB) input/output blob from rendering
 * thousands of expanded DOM nodes up front, which is what janks the main
 * thread when a span is selected.
 *
 * Kept JSX-free so the policy can be unit-tested without a DOM environment.
 */

/** Long string values are truncated to this many characters by default. */
export const STRING_TRUNCATE_AT = 240;

/** Whether a string value is long enough to be truncated by default. */
export function shouldTruncate(value: string): boolean {
  return value.length > STRING_TRUNCATE_AT;
}

/** The leading portion of a string shown while collapsed. */
export function truncateString(value: string): string {
  return value.length > STRING_TRUNCATE_AT ? value.slice(0, STRING_TRUNCATE_AT) : value;
}
