/**
 * What one run recorded for one case and scorer: a value, or why there is none. The
 * comparison page labels each case's cells by it, and a pair's "not included" counts
 * (`pairExclusions`) are tallied from it, so a cell and the count it falls into always
 * give the same reason. Also whether the comparison compared a cell, the change it found,
 * and why it set a recorded value aside, for the table.
 */
import {
  latestScoreByName,
  readScore,
  type ScorerCellComparison,
  type ScorerDirection,
  type ScorerValueType,
} from "@/lib/eval/comparison";
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

export const CELL_STATE_LABEL: Record<CellFailure, string> = {
  no_result: "No result",
  task_error: "Task error",
  scorer_error: "Scorer error",
  not_scored: "Not scored",
};

/** The task's error message when the task failed (empty when it failed without one), else
 *  null. An errored case that produced output, even an empty one, failed in a scorer, not
 *  in the task. */
export function taskErrorOf(result: ResultRow): string | null {
  if (result.taskError) return result.taskError;
  return result.status === "errored" && result.candidateOutput === null ? "" : null;
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

/** Why a run's whole line in a case has nothing to show, which the table says once rather
 *  than in every column. */
export type LineFailure = { kind: "no_result" } | { kind: "task_error"; message: string };

/** The run has no result for the case, or its task failed and no scorer recorded a value;
 *  null when the line has values to show. A scorer error, or a scorer that recorded
 *  nothing, is that scorer's alone, so it stays in its own column. */
export function lineFailure(
  result: ResultRow | undefined,
  scorerNames: readonly string[],
): LineFailure | null {
  if (!result) return { kind: "no_result" };
  const message = taskErrorOf(result);
  if (message === null) return null;
  const scored = scorerNames.some((name) => scorerCellState(result, name).kind === "value");
  return scored ? null : { kind: "task_error", message };
}

const COMPARED = new Set(["improved", "regressed", "unchanged", "changed"]);

/** Whether the comparison compared this cell (it counts towards the paired means). */
export const isCompared = (cell: ScorerCellComparison | undefined): boolean =>
  !!cell && COMPARED.has(cell.classification);

/** A compared cell's change as a number (true/false count as 1/0); null for text values
 *  or a cell the comparison left out. The engine leaves `delta` empty on a scorer with no
 *  direction, whose change is still shown, uncoloured. */
export function cellDelta(cell: ScorerCellComparison | undefined): number | null {
  if (!cell || !isCompared(cell)) return null;
  const num = (v: ScorerCellComparison["candidateValue"]) =>
    typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : null;
  const c = num(cell.candidateValue);
  const b = num(cell.baselineValue);
  return c !== null && b !== null ? c - b : null;
}

/** Whether a cell's values are labels, and which way is better, as its pair compared them.
 *  That can differ from its column's when another run recorded another kind of value for
 *  the scorer. A cell the pair has none of reads as its column. */
export function cellPolicy(
  cell: ScorerCellComparison | undefined,
  column: { valueType: ScorerValueType; direction: ScorerDirection },
): { categorical: boolean; direction: ScorerDirection } {
  return {
    categorical: (cell?.valueType ?? column.valueType) === "categorical",
    direction: cell?.direction ?? column.direction,
  };
}

// Why a value the run recorded was not compared with the baseline's.
export const MISMATCH = {
  version_mismatch: {
    label: "Version mismatch",
    why: "This run and the baseline used different versions of this scorer, so the values aren’t compared.",
  },
  type_mismatch: {
    label: "Type mismatch",
    why: "This run and the baseline recorded different kinds of value for this scorer, so the values aren’t compared.",
  },
} as const;
