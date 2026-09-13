/** Unbounded width against the Prisma pool or evaluator times out the whole tick, not one rule. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);

  return results;
}
