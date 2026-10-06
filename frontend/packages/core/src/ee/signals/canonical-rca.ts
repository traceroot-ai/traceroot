/**
 * A signal's canonical RCA: among its signal_rcas rows that hold a successful
 * answer, the one with the highest reopenSeq. Each row keeps the last answer
 * that covered its opening, so a later failed or pending attempt on a shared
 * finding never takes it away. Choosing by reopenSeq instead of completion time
 * means a slow RCA from an earlier opening never replaces a newer one. Returns
 * null while no RCA for the signal has succeeded.
 */
export function pickCanonicalRca<T extends { reopenSeq: number; result: string | null }>(
  rows: readonly T[],
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.result === null) continue;
    if (best === null || row.reopenSeq > best.reopenSeq) best = row;
  }
  return best;
}
