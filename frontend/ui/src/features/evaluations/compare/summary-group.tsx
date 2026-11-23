"use client";

import * as React from "react";
import { TBody, Td } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { GROUP_EDGE, INPUT_COLUMN, lineClass, lineEdge, RUN_COLUMN, RunCell } from "./cells";
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
 * The body's first group, "All cases": one line per run, like a case. Each candidate's
 * line shows, per scorer, its paired summary against the baseline (both means and the
 * change, then n and the improved/regressed counts), then mean latency and cost. The
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
}: {
  model: CompareModel;
  /** Each candidate's comparison with the baseline, by candidate run id. */
  pairs: ReadonlyMap<string, PairComparison>;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  tagOf: (runId: string) => string;
}) {
  const exclusions = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, pairExclusions(model, pair)])),
    [model, pairs],
  );
  const counts = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, countCellsByScorer(pair)])),
    [pairs],
  );
  const label = "All cases";
  const span = model.runs.length;

  return (
    <TBody aria-label={label}>
      {model.runs.map(({ run }, i) => {
        const isBaseline = run.id === model.baselineRunId;
        const first = i === 0;
        const edge = lineEdge(i === span - 1);
        const pair = pairs.get(run.id);
        return (
          <tr
            key={run.id}
            data-run-id={run.id}
            className={cn(lineClass(first, i === span - 1), isBaseline && "text-muted-foreground")}
          >
            {first && (
              <Td
                rowSpan={span}
                className={cn("align-top font-medium text-foreground", INPUT_COLUMN, GROUP_EDGE)}
              >
                {label}
              </Td>
            )}
            <RunCell
              dot={dotFor(run.id)}
              tag={tagOf(run.id)}
              label={labelOf(run.id)}
              isBaseline={isBaseline}
              className={cn(RUN_COLUMN, edge)}
            />
            <Td className={cn("align-top", edge)}>{isBaseline && "Baseline"}</Td>
            {first && <Td rowSpan={span} className={GROUP_EDGE} />}
            {model.scorers.map((s) => (
              <Td key={s.name} className={cn("text-right align-top tabular-nums", edge)}>
                {!isBaseline && (
                  <ScorerSummary
                    pair={pair}
                    exclusions={exclusions.get(run.id)}
                    counts={counts.get(run.id)}
                    column={s}
                    tagOf={tagOf}
                  />
                )}
              </Td>
            ))}
            <Td className={cn("text-right align-top tabular-nums", edge)}>
              {!isBaseline && (
                <MeanSummary
                  mean={durationOf(pair)}
                  measure="latency"
                  fmt={formatMs}
                  fmtDelta={signedWith(formatMs)}
                />
              )}
            </Td>
            <Td className={cn("text-right align-top tabular-nums", edge)}>
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
