"use client";

import * as React from "react";
import { Td } from "@/components/ui/table";
import type { ResultComparison, ScorerCellComparison } from "@/lib/eval/comparison";
import { cn } from "@/lib/utils";
import type { ResultRow } from "../types";
import {
  CellStateLabel,
  Delta,
  lineClass,
  lineEdge,
  PINNED_FILL,
  RUN_COLUMN,
  RunCell,
  TextValue,
} from "./cells";
import {
  CELL_STATE_LABEL,
  cellDelta,
  lineFailure,
  scorerCellState,
  taskErrorOf,
  type CellState,
  type LineFailure,
} from "./cell-state";
import { formatCost, formatMetricDelta, formatMs, signedWith } from "./metric-format";
import type { ScorerColumn } from "./model";
import { formatScore, MismatchMarker } from "./score-cell";

/** One run's value in a scorer column: what it recorded, with the change the comparison
 *  found against the baseline, or why it has no value. */
function ScorerValue({
  state,
  cell,
  column,
}: {
  state: CellState;
  /** The pair's cell for this case and scorer; absent on the baseline's own line. */
  cell: ScorerCellComparison | undefined;
  column: ScorerColumn;
}) {
  if (state.kind !== "value") return <CellStateLabel state={state} />;
  // A categorical scorer's values are labels, even when they are numbers: no change, only
  // whether it differs from the baseline's, which has no better or worse.
  const categorical = column.valueType === "categorical";
  const delta = categorical ? null : cellDelta(cell);
  return (
    <span className="whitespace-nowrap">
      {formatScore(state.value, column)}
      {(cell?.reason === "version_mismatch" || cell?.reason === "type_mismatch") && (
        <MismatchMarker reason={cell.reason} />
      )}
      {categorical && cell?.classification === "changed" && (
        <span className="ml-1 text-muted-foreground">changed</span>
      )}
      {delta !== null && (
        <Delta
          value={delta}
          text={formatMetricDelta(delta, column.format)}
          direction={column.direction}
        />
      )}
    </span>
  );
}

/** A per-case measure (latency, cost; lower is better), with its change against the
 *  baseline's when both recorded one. */
function MeasureValue({
  value,
  base,
  fmt,
}: {
  value: number | null;
  /** The baseline's value; undefined on the baseline's own line. */
  base: number | null | undefined;
  fmt: (n: number) => string;
}) {
  const delta = value !== null && base != null ? value - base : null;
  return (
    <span className="whitespace-nowrap">
      {value === null ? "—" : fmt(value)}
      {delta !== null && (
        <Delta value={delta} text={signedWith(fmt)(delta)} direction="lower_is_better" />
      )}
    </span>
  );
}

/** Why the line has nothing to show, said once: "No result in this run", or "Task error ·"
 *  and the task's own message (in full on hover when it is clipped). */
function LineMessage({ failure }: { failure: LineFailure }) {
  if (failure.kind === "no_result") {
    return <span className="text-muted-foreground">No result in this run</span>;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-muted-foreground">
      <span className="shrink-0">{CELL_STATE_LABEL.task_error}</span>
      {failure.message.trim() && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="min-w-0 flex-1">
            <TextValue text={failure.message} />
          </span>
        </>
      )}
    </span>
  );
}

/**
 * One run's line in a case's group: its Run cell, then its output, metrics, latency and
 * cost. The baseline's line is muted and shows values only; every other line shows its
 * value and the change the comparison found against the baseline. The group's first line
 * also carries the cells spanning the group (Input before Run, Expected after Output).
 *
 * A run with nothing to show on the line says so once (`lineFailure`): no result in the
 * output's place, with one empty cell across the rest; a failed task across the metric
 * columns, its output, latency and cost kept. A scorer's own error, or a scorer that
 * recorded nothing, stays in that scorer's column.
 *
 * The group's lines have no rule between them; the last draws the rule under the group.
 */
export function CaseLine({
  runId,
  result,
  isBaseline,
  baselineResult,
  pairCase,
  scorers,
  dot,
  tag,
  label,
  first,
  last,
  input,
  expected,
}: {
  runId: string;
  /** The run's result for the case; absent when it has none. */
  result: ResultRow | undefined;
  isBaseline: boolean;
  /** The baseline's result for the case, for the latency and cost changes. */
  baselineResult: ResultRow | undefined;
  /** The pair's comparison of the case; absent on the baseline's own line. */
  pairCase: ResultComparison | undefined;
  scorers: readonly ScorerColumn[];
  dot: string;
  tag: string;
  /** The run's tag and version, for the Run cell's tooltip. */
  label: string;
  first: boolean;
  last: boolean;
  /** On the first line: the Input cell spanning the group. */
  input?: React.ReactNode;
  /** On the first line: the Expected cell spanning the group. */
  expected?: React.ReactNode;
}) {
  const edge = lineEdge(last);
  const failure = lineFailure(
    result,
    scorers.map((s) => s.name),
  );
  const message = failure && <LineMessage failure={failure} />;
  // What the line says where its output would be.
  const output = () => {
    if (!result || (failure && scorers.length === 0)) return message;
    // A failed task whose scorers recorded something keeps the failure in this column.
    const taskError = taskErrorOf(result);
    if (taskError !== null && !failure) {
      return <CellStateLabel state={{ kind: "task_error", message: taskError }} />;
    }
    return <TextValue text={result.candidateOutput} />;
  };
  const baseValue = (get: (r: ResultRow) => number | null) =>
    isBaseline ? undefined : baselineResult ? get(baselineResult) : null;
  const measure = (get: (r: ResultRow) => number | null, fmt: (n: number) => string) =>
    result && (
      <Td className={cn("text-right align-top tabular-nums", edge)}>
        <MeasureValue value={get(result)} base={baseValue(get)} fmt={fmt} />
      </Td>
    );

  return (
    <tr
      data-run-id={runId}
      className={cn(lineClass(first, last), isBaseline && "text-muted-foreground")}
    >
      {input}
      <RunCell
        dot={dot}
        tag={tag}
        label={label}
        isBaseline={isBaseline}
        className={cn(RUN_COLUMN, PINNED_FILL, edge)}
      />
      <Td className={cn("max-w-[320px] align-top", edge)}>{output()}</Td>
      {expected}
      {!result ? (
        // With no result, everything after Output is one empty cell. `max-w-0` keeps it
        // from widening the columns.
        <Td colSpan={scorers.length + 2} className={cn("max-w-0 align-top", edge)} />
      ) : failure && scorers.length > 0 ? (
        <Td colSpan={scorers.length} className={cn("max-w-0 align-top", edge)}>
          {message}
        </Td>
      ) : (
        scorers.map((s) => (
          <Td
            key={s.name}
            className={cn(
              "text-right align-top",
              s.valueType !== "categorical" && "tabular-nums",
              edge,
            )}
          >
            <ScorerValue
              state={scorerCellState(result, s.name)}
              cell={pairCase?.scorerCells.find((c) => c.scorerName === s.name)}
              column={s}
            />
          </Td>
        ))
      )}
      {measure((r) => r.durationMs, formatMs)}
      {measure((r) => r.cost, formatCost)}
    </tr>
  );
}
