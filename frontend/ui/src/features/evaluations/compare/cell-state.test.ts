import { describe, expect, it } from "vitest";
import { compareRuns, type ScorerCellComparison } from "@/lib/eval/comparison";
import { toComparisonResults, toComparisonRun } from "@/lib/eval/comparison-db";
import {
  CELL_STATE_LABEL,
  cellPolicy,
  lineFailure,
  scoreRowsOf,
  scorerCellState,
  taskErrorOf,
} from "./cell-state";
import { QUALITY, fixtureResult, fixtureRun, fixtureScore } from "./__tests__/paired-fixture";
import type { ResultRow, ScoreRow } from "../types";

const result = (scores: ScoreRow[], overrides: Partial<ResultRow> = {}) =>
  fixtureResult("r", "tc-1", "one", scores, overrides);

describe("scorerCellState", () => {
  it("has no result when the run has no result for the case", () => {
    expect(scorerCellState(undefined, QUALITY)).toEqual({ kind: "no_result" });
  });

  it("reads the recorded value", () => {
    expect(scorerCellState(result([fixtureScore(QUALITY, 0.85)]), QUALITY)).toEqual({
      kind: "value",
      value: 0.85,
    });
    expect(scorerCellState(result([fixtureScore("route", "billing")]), "route")).toEqual({
      kind: "value",
      value: "billing",
    });
    expect(
      scorerCellState(result([{ ...fixtureScore(QUALITY, null), boolValue: true }]), QUALITY),
    ).toEqual({ kind: "value", value: true });
  });

  it("reads the row the comparison reads when a scorer recorded more than one", () => {
    const rows = [
      { ...fixtureScore(QUALITY, 0.9), scorerVersion: "2" },
      { ...fixtureScore(QUALITY, 0.4), scorerVersion: "1" },
    ];
    expect(scorerCellState(result(rows), QUALITY)).toEqual({ kind: "value", value: 0.9 });
  });

  it("is a task error when the task failed, with its message", () => {
    const failed = result([], { status: "errored", taskError: "Upstream timeout" });
    expect(scorerCellState(failed, QUALITY)).toEqual({
      kind: "task_error",
      message: "Upstream timeout",
    });
  });

  it("counts an errored case with no output as a task error", () => {
    const failed = result([], { status: "errored", candidateOutput: null });
    expect(scorerCellState(failed, QUALITY)).toEqual({ kind: "task_error", message: "" });
    // An errored case that produced output failed in a scorer, not in the task.
    expect(scorerCellState(result([], { status: "errored" }), QUALITY)).toEqual({
      kind: "not_scored",
    });
  });

  it("counts an errored case whose task returned an empty output as the scorer's error", () => {
    const scorerFailed = result([fixtureScore(QUALITY, null, "judge timed out")], {
      status: "errored",
      candidateOutput: "",
    });
    expect(scorerCellState(scorerFailed, QUALITY)).toEqual({
      kind: "scorer_error",
      message: "judge timed out",
    });
  });

  it("is a scorer error when the scorer failed, with its message", () => {
    const failed = result([fixtureScore(QUALITY, null, "judge timed out")]);
    expect(scorerCellState(failed, QUALITY)).toEqual({
      kind: "scorer_error",
      message: "judge timed out",
    });
  });

  it("puts a task error before the scorer error it caused", () => {
    const failed = result([fixtureScore(QUALITY, null, "no output to judge")], {
      taskError: "Upstream timeout",
    });
    expect(scorerCellState(failed, QUALITY).kind).toBe("task_error");
  });

  it("keeps a value a scorer recorded despite a task error", () => {
    const partial = result([fixtureScore(QUALITY, 0.2)], { taskError: "Upstream timeout" });
    expect(scorerCellState(partial, QUALITY)).toEqual({ kind: "value", value: 0.2 });
  });

  it("is not scored when the scorer recorded nothing for the case", () => {
    expect(scorerCellState(result([]), QUALITY)).toEqual({ kind: "not_scored" });
    expect(scorerCellState(result([fixtureScore(QUALITY, null)]), QUALITY)).toEqual({
      kind: "not_scored",
    });
  });
});

describe("taskErrorOf", () => {
  it("is the task's message, empty for an errored case without output, else null", () => {
    expect(taskErrorOf(result([], { taskError: "boom" }))).toBe("boom");
    expect(taskErrorOf(result([], { status: "errored", candidateOutput: null }))).toBe("");
    expect(taskErrorOf(result([], { status: "errored", candidateOutput: "" }))).toBeNull();
    expect(taskErrorOf(result([]))).toBeNull();
  });
});

describe("scoreRowsOf", () => {
  const older = { ...fixtureScore(QUALITY, 0.9), id: "quality-v1", scorerVersion: "1" };
  const newer = { ...fixtureScore(QUALITY, 0.6), id: "quality-v2", scorerVersion: "2" };
  const route = fixtureScore("route", "billing");

  it("picks one row per scorer, whatever order the rows were listed in", () => {
    for (const scores of [
      [older, newer, route],
      [route, newer, older],
    ]) {
      const rows = scoreRowsOf(result(scores));
      expect(rows.get(QUALITY)).toBe(newer);
      expect(rows.get("route")).toBe(route);
      expect(rows.size).toBe(2);
    }
  });

  it("picks the row the comparison compares", () => {
    const base = fixtureResult("a", "tc-1", "one", [
      { ...fixtureScore(QUALITY, 0.5), scorerVersion: "2" },
    ]);
    const cand = fixtureResult("b", "tc-1", "one", [older, newer]);
    const { results } = compareRuns({
      candidate: toComparisonRun(fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z")),
      candidateResults: toComparisonResults([cand]),
      baseline: toComparisonRun(fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z")),
      baselineResults: toComparisonResults([base]),
    });
    const cell = results[0].scorerCells.find((c) => c.scorerName === QUALITY);
    expect(cell?.candidateValue).toBe(scoreRowsOf(cand).get(QUALITY)?.numericValue);
    expect(cell?.baselineValue).toBe(scoreRowsOf(base).get(QUALITY)?.numericValue);
  });
});

describe("CELL_STATE_LABEL", () => {
  it("names each state a cell can be in instead of a value", () => {
    expect(CELL_STATE_LABEL).toEqual({
      no_result: "No result",
      task_error: "Task error",
      scorer_error: "Scorer error",
      not_scored: "Not scored",
    });
  });
});

describe("lineFailure", () => {
  const scorers = [QUALITY, "route"];

  it("says a run with no result for the case has none, once for its whole line", () => {
    expect(lineFailure(undefined, scorers)).toEqual({ kind: "no_result" });
  });

  it("says a failed task once when no scorer recorded a value", () => {
    const failed = result([], { status: "errored", taskError: "Upstream timeout" });
    expect(lineFailure(failed, scorers)).toEqual({
      kind: "task_error",
      message: "Upstream timeout",
    });
    const silent = result([], { status: "errored", candidateOutput: null });
    expect(lineFailure(silent, scorers)).toEqual({ kind: "task_error", message: "" });
  });

  it("leaves a line with values to its columns", () => {
    expect(lineFailure(result([fixtureScore(QUALITY, 0.9)]), scorers)).toBeNull();
    // A scorer error or an unscored scorer is that scorer's alone.
    expect(
      lineFailure(result([fixtureScore(QUALITY, null, "judge timed out")]), scorers),
    ).toBeNull();
    expect(lineFailure(result([]), scorers)).toBeNull();
    // A scorer that recorded a value despite the failed task keeps it in its column.
    const scoredAnyway = result([fixtureScore("route", "billing")], {
      status: "errored",
      taskError: "Upstream timeout",
    });
    expect(lineFailure(scoredAnyway, scorers)).toBeNull();
  });
});

describe("cellPolicy", () => {
  const labels = { valueType: "categorical", direction: "none" } as const;
  const cell = (over: Partial<ScorerCellComparison>): ScorerCellComparison => ({
    scorerName: QUALITY,
    scorerVersion: "1",
    valueType: "numeric",
    direction: "higher_is_better",
    candidateValue: 0.8,
    baselineValue: 0.4,
    delta: 0.4,
    classification: "improved",
    ...over,
  });

  it("reads a cell as its pair compared it, not as its column", () => {
    expect(cellPolicy(cell({}), labels)).toEqual({
      categorical: false,
      direction: "higher_is_better",
    });
  });

  it("falls back to the column for what the cell leaves open, or with no cell", () => {
    expect(cellPolicy(cell({ valueType: null, direction: null }), labels)).toEqual({
      categorical: true,
      direction: "none",
    });
    expect(cellPolicy(undefined, labels)).toEqual({ categorical: true, direction: "none" });
  });
});
