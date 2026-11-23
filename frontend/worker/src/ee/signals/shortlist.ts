/** Cosine similarity; 0 when either vector is empty, zero, or the lengths differ. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * The k signals whose anchors are nearest the hit, nearest first. No threshold:
 * the shortlist only narrows the field, the assignment model decides. Ties keep
 * the input order, so the result is deterministic.
 */
export function shortlist<T extends { anchorEmbedding: readonly number[] }>(
  vector: readonly number[],
  signals: readonly T[],
  k: number,
): T[] {
  return signals
    .map((s, i) => ({ s, i, sim: cosine(vector, s.anchorEmbedding) }))
    .sort((x, y) => y.sim - x.sim || x.i - y.i)
    .slice(0, k)
    .map((x) => x.s);
}
