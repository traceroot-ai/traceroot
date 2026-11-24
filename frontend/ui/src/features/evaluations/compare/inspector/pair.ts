/**
 * Which two runs the trace panel compares. It opens on the table's baseline and a
 * candidate; inside it either side can be any compared run, and swapping them is local to
 * it. The case stays the table's row, so a pair of two runs on another dataset than the
 * table's baseline is matched by input, as the table matched them, not by their shared
 * case id.
 */
import type { CompareModel } from "../model";

const compared = (model: CompareModel, runId: string | null): runId is string =>
  !!runId && model.runs.some((b) => b.run.id === runId);

/** The candidate a case opens with: the run whose value was clicked, else the last
 *  candidate shown, else the first run after the baseline. Never the table's baseline;
 *  null when there is no other run. */
export function openingCandidate(
  model: CompareModel,
  clicked: string | null,
  last: string | null,
): string | null {
  for (const runId of [clicked, last]) {
    if (runId !== model.baselineRunId && compared(model, runId)) return runId;
  }
  return model.runs.find((b) => b.run.id !== model.baselineRunId)?.run.id ?? null;
}

/** The `[baseline, candidate]` to show: the requested pair while both are compared runs
 *  and differ, else the table's baseline with the opening candidate. */
export function resolvePair(
  model: CompareModel,
  requested: readonly [string, string] | null,
  last: string | null,
): [string, string] | null {
  if (
    requested &&
    requested[0] !== requested[1] &&
    compared(model, requested[0]) &&
    compared(model, requested[1])
  ) {
    return [requested[0], requested[1]];
  }
  const candidate = openingCandidate(model, null, last);
  return candidate ? [model.baselineRunId, candidate] : null;
}
