/**
 * The most results the run detail read returns for one run (and for its baseline).
 *
 * A run's result set is unbounded in principle: a large run can have thousands of cases,
 * each carrying several @db.Text columns plus per-scorer rows. Capping keeps a single
 * request's query size and response payload bounded; `resultsTruncated` tells the caller
 * when they are looking at a partial view. This is a stopgap, not real pagination; a
 * fuller approach would page `results` while keeping the aggregate `comparison` computed
 * over the full set.
 *
 * Shared with the client so a page can tell a run cut off here from a run that reported
 * fewer cases than it declared, which `resultsTruncated` flags the same way.
 */
export const MAX_RUN_DETAIL_RESULTS = 1000;
