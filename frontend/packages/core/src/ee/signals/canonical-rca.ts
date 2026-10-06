/**
 * A signal's canonical RCA: among its signal_rcas rows whose RCA is done, the one
 * with the highest reopenSeq. Choosing by reopenSeq instead of completion time
 * means a slow RCA from an earlier opening never replaces a newer one. Returns
 * null while no RCA for the signal has finished.
 */
export function pickCanonicalRca<T extends { reopenSeq: number; rca: { status: string } }>(
  rows: readonly T[],
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.rca.status !== "done") continue;
    if (best === null || row.reopenSeq > best.reopenSeq) best = row;
  }
  return best;
}
