"use client";

import * as React from "react";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import type { ResultComparison, ScorerCellComparison } from "@/lib/eval/comparison";
import { cn } from "@/lib/utils";
import type { ResultRow } from "../../types";
import { Delta, Dot } from "../cells";
import {
  CELL_STATE_LABEL,
  cellDelta,
  cellPolicy,
  isCompared,
  scoreRowsOf,
  scorerCellState,
} from "../cell-state";
import { formatMetricDelta } from "../metric-format";
import type { ScorerColumn } from "../model";
import { formatScore, MismatchMarker } from "../score-cell";

/** One run's score for the case: the value the comparison read (or why there is none),
 *  then the scorer's explanation and its error, in full. */
function SideScore({ result, column }: { result: ResultRow | undefined; column: ScorerColumn }) {
  const state = scorerCellState(result, column.name);
  // The row the comparison read, so the explanation never belongs to another version.
  const score = result && scoreRowsOf(result).get(column.name);
  // A task error is the output's story, told once beside it, not under every scorer.
  const error = state.kind === "scorer_error" ? state.message : (score?.error ?? null);
  return (
    <div className="space-y-1">
      {state.kind === "value" ? (
        <p className="tabular-nums">{formatScore(state.value, column)}</p>
      ) : (
        <p className="text-muted-foreground">{CELL_STATE_LABEL[state.kind]}</p>
      )}
      {score?.explanation && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{score.explanation}</p>
      )}
      {error && <p className="whitespace-pre-wrap break-words text-destructive">{error}</p>}
    </div>
  );
}

/** The change the comparison found for the pair, or why it compared nothing. */
function ScoreChange({
  cell,
  column,
}: {
  cell: ScorerCellComparison | undefined;
  column: ScorerColumn;
}) {
  if (cell?.reason === "version_mismatch" || cell?.reason === "type_mismatch") {
    return <MismatchMarker reason={cell.reason} />;
  }
  if (!isCompared(cell)) return <span className="text-muted-foreground">—</span>;
  // A categorical scorer's values are labels: they changed or they didn't. Read as the pair
  // compared them, as the table and its summary do.
  const { categorical, direction } = cellPolicy(cell, column);
  const delta = categorical ? null : cellDelta(cell);
  const text = delta === null ? "" : formatMetricDelta(delta, column.format);
  // A change that rounds to nothing in the column's unit has no sign, and `Delta` draws
  // nothing for it: it reads as no change, as its two values do.
  if (delta === null || !/^[+−]/.test(text)) {
    return (
      <span className="text-muted-foreground">
        {cell?.classification === "changed" ? "Changed" : "No change"}
      </span>
    );
  }
  return <Delta value={delta} text={text} direction={direction} />;
}

// The table fills a box like the ones above it, its text on their inner edge rather than
// on the page table's wider gutter.
const FIRST = "!pl-2.5";
const LAST = "!pr-2.5";

/** Every scorer's value on both runs of the pair, with the change between them. */
export function ScoresTable({
  scorers,
  baseline,
  candidate,
  comparison,
}: {
  scorers: readonly ScorerColumn[];
  baseline: { result: ResultRow | undefined; heading: string; dot: string };
  candidate: { result: ResultRow | undefined; heading: string; dot: string };
  /** The pair's comparison of this case. */
  comparison: ResultComparison | null;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TRHead>
            <Th className={cn("w-[160px]", FIRST)}>Scorer</Th>
            {[baseline, candidate].map((side) => (
              <Th key={side.heading}>
                <span className="flex items-center gap-1.5">
                  <Dot color={side.dot} />
                  {side.heading}
                </span>
              </Th>
            ))}
            <Th className={cn("w-[130px] text-right", LAST)}>Change</Th>
          </TRHead>
        </THead>
        <TBody>
          {scorers.map((column) => (
            <TR key={column.name}>
              <Td className={cn("whitespace-normal break-words align-top", FIRST)}>
                {column.name}
              </Td>
              <Td className="whitespace-normal align-top">
                <SideScore result={baseline.result} column={column} />
              </Td>
              <Td className="whitespace-normal align-top">
                <SideScore result={candidate.result} column={column} />
              </Td>
              <Td className={cn("text-right align-top tabular-nums", LAST)}>
                <ScoreChange
                  cell={comparison?.scorerCells.find((c) => c.scorerName === column.name)}
                  column={column}
                />
              </Td>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
