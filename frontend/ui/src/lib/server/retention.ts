import { getRetentionDays } from "@traceroot/core";

// One-hour buffer so "Last N days" filters don't race the server clock and
// clamp a request that is only milliseconds inside the window. Mirrors the
// backend gate (backend/rest/retention.py, hours=1).
const BOUNDARY_BUFFER_MS = 3_600_000;

/** The plan's cutoff as epoch ms, or null when the plan has unlimited retention. */
function getRetentionCutoffMs(billingPlan: string): number | null {
  const days = getRetentionDays(billingPlan);
  if (days === null) return null;
  return Date.now() - days * 86_400_000 - BOUNDARY_BUFFER_MS;
}

function getRetentionCutoff(billingPlan: string): string | null {
  const ms = getRetentionCutoffMs(billingPlan);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Clamp a request's `start_after` to the plan's retention cutoff — the
 * server-side safety net for the Node proxies (the UI date picker already
 * prevents out-of-window selections). A missing or unparseable `start_after`,
 * or one older than the cutoff, is pulled forward to the cutoff. Returns the
 * value unchanged when the plan has unlimited retention (cutoff === null),
 * including a null passthrough that callers requiring the param still reject.
 */
export function clampStartAfter(billingPlan: string, startAfter: string | null): string | null {
  const cutoff = getRetentionCutoff(billingPlan);
  if (!cutoff) return startAfter;
  const parsed = startAfter ? new Date(startAfter).getTime() : NaN;
  if (!startAfter || isNaN(parsed) || parsed < new Date(cutoff).getTime()) {
    return cutoff;
  }
  return startAfter;
}

/**
 * The by-id half of the gate: true when a record's own timestamp falls outside
 * the plan's retention window, so the caller can answer 403.
 *
 * A list has a window to pull forward, so it clamps silently (`clampStartAfter`
 * above). A by-id read has none — the only answers are the record or a refusal —
 * which is exactly the split the telemetry routes already make between
 * `clamp_retention_window` and `enforce_retention_by_time` in
 * backend/rest/retention.py. This is that second helper for the Node routes, on
 * the same cutoff (and the same one-hour boundary buffer) as the clamp.
 *
 * An unlimited-retention plan gates nothing. A missing timestamp gates nothing
 * either, matching the Python helper's `timestamp is not None` guard: absent is
 * not evidence of being outside the window.
 */
export function isOutsideRetention(
  billingPlan: string,
  timestamp: Date | null | undefined,
): boolean {
  const cutoffMs = getRetentionCutoffMs(billingPlan);
  if (cutoffMs === null || timestamp == null) return false;
  return timestamp.getTime() < cutoffMs;
}
