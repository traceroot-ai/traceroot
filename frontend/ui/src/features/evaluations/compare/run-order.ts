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
