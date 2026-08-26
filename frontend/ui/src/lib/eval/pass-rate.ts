/**
 * Run pass rate — derived from stored per-result statuses, never from the run's
 * stored counters. See docs/offline-eval-run-pass-rate-design.md.
 *
 * The denominator is `passed + failed`, inherited from the SDK's own definition
 * (`traceroot-py/traceroot/eval/results.py`: `scored_count = passed + failed`).
 * `errored` (the candidate app broke) and `not_scored` (no numeric/boolean main
 * score) are excluded from both sides: neither is a bad grade.
 */

export interface ResultStatusCounts {
  passedCount: number;
  failedCount: number;
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
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
    notScoredCount: 0,
  };
  for (const r of results) {
    const n = r.count ?? 1;
    if (r.status === "passed") counts.passedCount += n;
    else if (r.status === "failed") counts.failedCount += n;
    else if (r.status === "errored") counts.erroredCount += n;
    else if (r.status === "not_scored") counts.notScoredCount += n;
  }
  return counts;
}

/**
 * Null when nothing was judged — an all-errored run must render "—", never "0%",
 * which would read as a catastrophic quality regression rather than a broken harness.
 */
export function passRate(passedCount: number, failedCount: number): number | null {
  const judged = passedCount + failedCount;
  return judged === 0 ? null : passedCount / judged;
}

/** Human phrase for the cases the fraction excludes, or null when it excludes none. */
export function excludedSummary(erroredCount: number, notScoredCount: number): string | null {
  const parts: string[] = [];
  if (erroredCount > 0) parts.push(`${erroredCount} errored`);
  if (notScoredCount > 0) parts.push(`${notScoredCount} not scored`);
  return parts.length > 0 ? parts.join(", ") : null;
}
