/**
 * Per-status result counts for a run, derived from the stored result rows rather
 * than the run's own counters. A case is `errored` (the candidate app or a scorer
 * threw) or `not_scored`.
 */

export interface ResultStatusCounts {
  erroredCount: number;
  notScoredCount: number;
}

/**
 * Fold result statuses into per-status counts. Rows may be individual results or
 * pre-aggregated groups: `count` defaults to 1, so the same fold serves both a list
 * of result rows and a `groupBy(["runId", "status"])` projection, which is how the
 * runs list gets these counts without materialising the rows.
 */
export function countResultStatuses(
  results: Array<{ status: string; count?: number }>,
): ResultStatusCounts {
  const counts: ResultStatusCounts = {
    erroredCount: 0,
    notScoredCount: 0,
  };
  for (const r of results) {
    const n = r.count ?? 1;
    if (r.status === "errored") counts.erroredCount += n;
    else if (r.status === "not_scored") counts.notScoredCount += n;
  }
  return counts;
}

/** Human phrase for a run's unscorable cases, or null when it has none. */
export function excludedSummary(erroredCount: number, notScoredCount: number): string | null {
  const parts: string[] = [];
  if (erroredCount > 0) parts.push(`${erroredCount} errored`);
  if (notScoredCount > 0) parts.push(`${notScoredCount} not scored`);
  return parts.length > 0 ? parts.join(", ") : null;
}
