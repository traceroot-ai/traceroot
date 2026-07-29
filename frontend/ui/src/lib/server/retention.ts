import { getRetentionDays } from "@traceroot/core";

// One-hour buffer so "Last N days" filters don't race the server clock and
// clamp a request that is only milliseconds inside the window. Mirrors the
// backend gate (backend/rest/retention.py, hours=1).
const BOUNDARY_BUFFER_MS = 3_600_000;

function getRetentionCutoff(billingPlan: string): string | null {
  const days = getRetentionDays(billingPlan);
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000 - BOUNDARY_BUFFER_MS).toISOString();
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
