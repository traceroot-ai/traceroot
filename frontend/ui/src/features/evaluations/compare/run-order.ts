/**
 * The order runs are compared in. Kept apart from the comparison model so the runs list
 * can pick a default baseline without loading the comparison engine.
 */
import type { RunRow } from "../types";

type RunAge = Pick<RunRow, "id" | "runNumber" | "startedAt">;

const startedMs = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Oldest run first: by start time, then run number, then id, so ties never depend on the
 *  order the runs arrived in. Run numbers alone can't order runs: they restart per
 *  evaluation. An unparseable start time sorts as the epoch. */
export function oldestFirst(a: RunAge, b: RunAge): number {
  return (
    startedMs(a.startedAt) - startedMs(b.startedAt) ||
    a.runNumber - b.runNumber ||
    a.id.localeCompare(b.id)
  );
}

/** The newest of `runs` on `anchor`'s dataset that started before `anchor`, leaving out
 *  `exclude` (the runs already compared); null when there is none. */
export function previousRun<T extends RunAge & Pick<RunRow, "datasetId">>(
  runs: readonly T[],
  anchor: RunAge & Pick<RunRow, "datasetId">,
  exclude: ReadonlySet<string>,
): T | null {
  let previous: T | null = null;
  for (const r of runs) {
    if (r.datasetId !== anchor.datasetId || exclude.has(r.id)) continue;
    if (oldestFirst(r, anchor) >= 0) continue;
    if (!previous || oldestFirst(r, previous) > 0) previous = r;
  }
  return previous;
}

/** The run of `bundles` that started last (by `oldestFirst`); undefined when there are none. */
export function newestRun<T extends { run: RunAge }>(bundles: readonly T[]): T | undefined {
  return bundles.reduce<T | undefined>(
    (newest, b) => (!newest || oldestFirst(b.run, newest.run) > 0 ? b : newest),
    undefined,
  );
}
