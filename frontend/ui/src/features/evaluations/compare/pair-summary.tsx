"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CountBlock, ScorerDirection } from "@/lib/eval/comparison";
import { Delta } from "./cells";
import { casesText } from "./coverage";
import { sameFilter, type CaseFilter } from "./filters";
import { formatMetricDelta, formatMetricValue } from "./metric-format";
import type { Exclusion, PairComparison, ScorerColumn } from "./model";

/** One line of the "not included" list, e.g. "1 case with a task error in #2". */
export function describeExclusion(e: Exclusion, tagOf: (runId: string) => string): string {
  const cases = casesText(e.count);
  const where = e.runId === null ? "both runs" : tagOf(e.runId);
  switch (e.reason) {
    case "no_result":
      return `${cases} with no result in ${where}`;
    case "task_error":
      return `${cases} with a task error in ${where}`;
    case "scorer_error":
      return `${cases} with a scorer error in ${where}`;
    case "not_scored":
      return e.runId === null
        ? `${cases} not scored in either run`
        : `${cases} not scored in ${where}`;
    case "version_mismatch":
      return `${cases} scored by different scorer versions`;
    case "type_mismatch":
      return `${cases} scored as different value types`;
  }
}

/** "n=7", explaining on hover which cases the number covers and which it leaves out. */
function PairedCount({
  n,
  covers,
  notIncluded = [],
}: {
  n: number;
  covers: string;
  notIncluded?: string[];
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default">
          n={n}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[320px] text-left">
        <p>{covers}</p>
        {notIncluded.length > 0 && (
          <>
            <p className="mt-1">Not included:</p>
            <ul>
              {notIncluded.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const CHANGE_ARROW = { improved: "↗", regressed: "↘" } as const;

/** "↗ 6 ↘ 1": how many of the pair's cases the candidate improved and regressed on, quiet
 *  beside the means. Each count filters the table to those cases, and takes the filter off
 *  again. */
function ChangeCounts({
  counts,
  scorer,
  runId,
  tag,
  filters,
  onToggleFilter,
}: {
  counts: Pick<CountBlock, "improved" | "regressed">;
  scorer: string;
  runId: string;
  tag: string;
  filters: readonly CaseFilter[];
  onToggleFilter: (filter: CaseFilter) => void;
}) {
  return (
    <span
      role="group"
      aria-label={`${counts.improved} improved, ${counts.regressed} regressed vs baseline`}
      className="inline-flex gap-0.5"
    >
      {(["improved", "regressed"] as const).map((kind) => {
        const n = counts[kind];
        const filter: CaseFilter = { kind, scorer, runId };
        const active = filters.some((f) => sameFilter(f, filter));
        return (
          <button
            key={kind}
            type="button"
            aria-label={`Show ${casesText(n)} where ${tag} ${kind} on ${scorer}`}
            aria-pressed={active}
            disabled={n === 0 && !active}
            onClick={() => onToggleFilter(filter)}
            className={cn(
              "rounded-[2px] px-0.5 hover:bg-muted hover:text-foreground disabled:pointer-events-none",
              active && "bg-muted text-foreground ring-1 ring-inset ring-border",
            )}
          >
            {CHANGE_ARROW[kind]} {n}
          </button>
        );
      })}
    </span>
  );
}

/** A summary line's value: the main figure, then the small, muted detail beside it (or
 *  under it, when the column is narrow). */
function SummaryValue({ main, sub }: { main: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
      <span className="whitespace-nowrap">{main}</span>
      {sub && (
        <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
          {sub}
        </span>
      )}
    </span>
  );
}

/** "78.6% → 82.1% +3.6 pp": the baseline's and the candidate's paired means, and the change. */
function MeanLine({
  baseline,
  candidate,
  delta,
  fmt,
  deltaText,
  direction,
}: {
  baseline: number;
  candidate: number;
  delta: number;
  fmt: (v: number) => string;
  deltaText: string;
  direction: ScorerDirection;
}) {
  return (
    <span>
      <span>{`${fmt(baseline)} → ${fmt(candidate)}`}</span>
      <Delta value={delta} text={deltaText} direction={direction} />
    </span>
  );
}

/** A candidate's line under a scorer: both means over the cases the pair scored and the
 *  change, or for a categorical scorer how many of those cases changed value; then n and
 *  the improved/regressed counts. */
export function ScorerSummary({
  pair,
  exclusions,
  counts,
  column,
  tagOf,
  filters,
  onToggleFilter,
}: {
  pair: PairComparison | undefined;
  /** Scorer name → the pair's cases left out of its count. */
  exclusions: ReadonlyMap<string, Exclusion[]> | undefined;
  /** Scorer name → the pair's cells by classification. */
  counts: ReadonlyMap<string, CountBlock> | undefined;
  column: ScorerColumn;
  tagOf: (runId: string) => string;
  /** The table's filters, so a count shows when it is the one applied. */
  filters: readonly CaseFilter[];
  onToggleFilter: (filter: CaseFilter) => void;
}) {
  const agg = pair?.comparison.scorers.find((s) => s.name === column.name);
  if (!pair || !agg) return <span>—</span>;
  const runId = pair.candidateRunId;
  const n = agg.pairedCount;
  const count = (
    <PairedCount
      n={n}
      covers={
        n === 0
          ? "No case was scored in both runs."
          : `${agg.transitions ? "Changes across" : "Mean of"} the ${casesText(n)} both runs scored.`
      }
      notIncluded={exclusions?.get(column.name)?.map((e) => describeExclusion(e, tagOf))}
    />
  );
  if (agg.transitions) {
    return <SummaryValue main={`changed ${agg.transitions.changed} of ${n}`} sub={count} />;
  }
  const cells = counts?.get(column.name);
  const sub = (
    <>
      {count}
      {cells && (
        <ChangeCounts
          counts={cells}
          scorer={column.name}
          runId={runId}
          tag={tagOf(runId)}
          filters={filters}
          onToggleFilter={onToggleFilter}
        />
      )}
    </>
  );
  if (agg.baselineMean === null || agg.candidateMean === null || agg.delta === null) {
    return <SummaryValue main="—" sub={sub} />;
  }
  // Coloured by the pair's own direction, the one its improved and regressed counts used.
  return (
    <SummaryValue
      main={
        <MeanLine
          baseline={agg.baselineMean}
          candidate={agg.candidateMean}
          delta={agg.delta}
          fmt={(v) => formatMetricValue(v, column.format)}
          deltaText={formatMetricDelta(agg.delta, column.format)}
          direction={agg.direction}
        />
      }
      sub={sub}
    />
  );
}

export interface PairedMean {
  baselineMean: number | null;
  candidateMean: number | null;
  delta: number | null;
  pairedCount: number;
}

/** A candidate's line under a per-case measure (latency, cost; lower is better): both
 *  means over the cases where both runs reported it, the change, then n. */
export function MeanSummary({
  mean,
  measure,
  fmt,
  fmtDelta,
}: {
  mean: PairedMean | undefined;
  /** What the mean is of, for its explanation, e.g. "latency". */
  measure: string;
  fmt: (v: number) => string;
  fmtDelta: (delta: number) => string;
}) {
  if (!mean) return <span>—</span>;
  const n = mean.pairedCount;
  const count = (
    <PairedCount
      n={n}
      covers={
        n === 0
          ? `No case has a ${measure} in both runs.`
          : `Mean of the ${casesText(n)} where both runs reported a ${measure}.`
      }
    />
  );
  if (mean.baselineMean === null || mean.candidateMean === null || mean.delta === null) {
    return <SummaryValue main="—" sub={count} />;
  }
  return (
    <SummaryValue
      main={
        <MeanLine
          baseline={mean.baselineMean}
          candidate={mean.candidateMean}
          delta={mean.delta}
          fmt={fmt}
          deltaText={fmtDelta(mean.delta)}
          direction="lower_is_better"
        />
      }
      sub={count}
    />
  );
}
