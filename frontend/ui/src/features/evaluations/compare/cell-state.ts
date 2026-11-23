/**
 * What one run recorded for one case and scorer: a value, or why there is none. A pair's
 * "not included" counts (`pairExclusions`) are tallied from it, so each case falls into
 * the count for the reason its cell has. Also whether the comparison compared a cell.
 */
import { latestScoreByName, readScore, type ScorerCellComparison } from "@/lib/eval/comparison";
import type { ResultRow, ScoreRow } from "../types";

/** Each scorer's score row on a result, the one the comparison engine reads (the highest
 *  scorer version), by scorer name. Every value, column and count on the page picks its
 *  row here, so a value never sits beside a change the engine took from another row. */
export function scoreRowsOf(result: ResultRow): ReadonlyMap<string, ScoreRow> {
  // The engine picks among the rows it is given and hands them back as they are.
  return latestScoreByName(result.scores) as Map<string, ScoreRow>;
}

export type CellState =
  | { kind: "value"; value: number | boolean | string }
  /** The run has no result for this case. */
  | { kind: "no_result" }
  | { kind: "task_error"; message: string }
  | { kind: "scorer_error"; message: string }
  /** The result exists, but this scorer recorded nothing for it. */
  | { kind: "not_scored" };

/** Why a cell has no value. */
export type CellFailure = Exclude<CellState["kind"], "value">;

/** The task's error message when the task failed (empty when it failed without one), else
 *  null. An errored case that produced output failed in a scorer, not in the task. */
export function taskErrorOf(result: ResultRow): string | null {
  if (result.taskError) return result.taskError;
  return result.status === "errored" && !result.candidateOutput ? "" : null;
}

export function scorerCellState(result: ResultRow | undefined, scorerName: string): CellState {
  if (!result) return { kind: "no_result" };
  // The row the comparison engine reads, so a cell never shows a value it didn't compare.
  const score = scoreRowsOf(result).get(scorerName);
  const read = readScore(score);
  if (read.kind === "value") return { kind: "value", value: read.value };
  // A failed task explains a missing or failed score better than the score does.
  const taskError = taskErrorOf(result);
  if (taskError !== null) return { kind: "task_error", message: taskError };
  if (read.kind === "error") return { kind: "scorer_error", message: score?.error ?? "" };
  return { kind: "not_scored" };
}

const COMPARED = new Set(["improved", "regressed", "unchanged", "changed"]);

/** Whether the comparison compared this cell (it counts towards the paired means). */
export const isCompared = (cell: ScorerCellComparison | undefined): boolean =>
  !!cell && COMPARED.has(cell.classification);
