"use client";

import * as React from "react";
import { TBody, Td } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { GROUP_EDGE, INPUT_COLUMN, lineClass, lineEdge, RUN_COLUMN, RunCell } from "./cells";
import type { CaseFilter } from "./filters";
import { formatCost, formatMs, signedWith } from "./metric-format";
import {
  countCellsByScorer,
  pairExclusions,
  type CompareModel,
  type PairComparison,
} from "./model";
import { MeanSummary, ScorerSummary, type PairedMean } from "./pair-summary";

const durationOf = (pair: PairComparison | undefined): PairedMean | undefined => {
  const d = pair?.comparison.duration;
  return (
    d && {
      baselineMean: d.baselineMeanMs,
      candidateMean: d.candidateMeanMs,
      delta: d.deltaMs,
      pairedCount: d.pairedCount,
    }
  );
};

/**
 * The body's first group, "All cases" (or "Matching cases" while a search or filters
 * narrow them): one line per run, like a case. Each candidate's line shows, per scorer,
 * its paired summary against the baseline (both means and the change, then n and the
 * improved/regressed counts, which filter the table), then mean latency and cost. The
 * baseline's line is labelled "Baseline" and repeats no number: each candidate's line
 * already reads "baseline → candidate" for its own pair, and the baseline's mean differs
 * from pair to pair when they cover different cases. It scrolls with the cases; only the
 * label row stays on top.
 */
export function SummaryGroup({
  model,
  pairs,
  dotFor,
  labelOf,
  tagOf,
  filters,
  onToggleFilter,
  filtering,
}: {
  model: CompareModel;
  /** Each candidate's comparison with the baseline, by candidate run id. */
  pairs: ReadonlyMap<string, PairComparison>;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  tagOf: (runId: string) => string;
  filters: readonly CaseFilter[];
  onToggleFilter: (filter: CaseFilter) => void;
  /** Whether a search or filters narrow the cases it covers. */
  filtering: boolean;
}) {
  const exclusions = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, pairExclusions(model, pair)])),
    [model, pairs],
  );
  const counts = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, countCellsByScorer(pair)])),
    [pairs],
  );
  const label = filtering ? "Matching cases" : "All cases";
  const span = model.runs.length;

  return (
    <TBody aria-label={label}>
      {model.runs.map(({ run }, i) => {
        const isBaseline = run.id === model.baselineRunId;
        const first = i === 0;
        const last = i === span - 1;
        const edge = lineEdge(last);
        const numeric = cn("text-right align-top tabular-nums", edge);
        const pair = pairs.get(run.id);
        return (
          <tr
            key={run.id}
            data-run-id={run.id}
            className={cn(lineClass(first, last), isBaseline && "text-muted-foreground")}
          >
            {first && (
              <Td
                rowSpan={span}
                className={cn(
                  "col-sticky-start align-top font-medium text-foreground",
                  INPUT_COLUMN,
                  // A summary, not a case: it keeps its fill under the pointer.
                  "!bg-background",
                  GROUP_EDGE,
                )}
              >
                {label}
              </Td>
            )}
            <RunCell
              dot={dotFor(run.id)}
              tag={tagOf(run.id)}
              label={labelOf(run.id)}
              isBaseline={isBaseline}
              className={cn(RUN_COLUMN, "bg-background", edge)}
            />
            <Td className={cn("align-top", edge)}>{isBaseline && "Baseline"}</Td>
            {first && <Td rowSpan={span} className={GROUP_EDGE} />}
            {model.scorers.map((s) => (
              <Td key={s.name} className={numeric}>
                {!isBaseline && (
                  <ScorerSummary
                    pair={pair}
                    exclusions={exclusions.get(run.id)}
                    counts={counts.get(run.id)}
                    column={s}
                    tagOf={tagOf}
                    filters={filters}
                    onToggleFilter={onToggleFilter}
                  />
                )}
              </Td>
            ))}
            <Td className={numeric}>
              {!isBaseline && (
                <MeanSummary
                  mean={durationOf(pair)}
                  measure="latency"
                  fmt={formatMs}
                  fmtDelta={signedWith(formatMs)}
                />
              )}
            </Td>
            <Td className={numeric}>
              {!isBaseline && (
                <MeanSummary
                  mean={pair?.cost}
                  measure="cost"
                  fmt={formatCost}
                  fmtDelta={signedWith(formatCost)}
                />
              )}
            </Td>
          </tr>
        );
      })}
    </TBody>
  );
}
