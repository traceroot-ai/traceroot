"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { EmptyState } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import type { ScorerDirection } from "@/lib/eval/comparison";
import { cn } from "@/lib/utils";
import { useEvaluationRunDetails } from "../hooks";
import { Delta, Dot, RunLabel } from "../compare/cells";
import { scoreRowsOf } from "../compare/cell-state";
import {
  formatCost,
  formatMetricDelta,
  formatMetricValue,
  formatMs,
  signedWith,
  type MetricFormat,
} from "../compare/metric-format";
import {
  buildCompareModel,
  comparePairs,
  countCellsByScorer,
  inputKeyOf,
  pairExclusions,
  type CaseRow,
  type PairComparison,
  type RunBundle,
  type ScorerColumn,
} from "../compare/model";
import { MeanSummary, ScorerSummary, type PairedMean } from "../compare/pair-summary";
import type { ResultRow, ScoreRow } from "../types";

// A run comparison is N runs (2+) lined up case-by-case, anchored on the baseline run
// (alignment lives in `../compare/model`). Each metric column stacks one value per run,
// colour-keyed to the baseline picker; against the chosen baseline every other run also
// shows a green/red improvement/regression delta — à la a side-by-side experiment diff.
// The summary row compares each other run with the baseline on the cases both of them
// scored. Row drill-in is postponed (cells expand to full text).

// Stable per-run colours, keyed by selection order so a baseline change never
// recolours the table. The baseline picker is the legend.
const RUN_DOTS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
];

// ── Formatters ────────────────────────────────────────────────────────────
/** A scorer column's value and change formatters, from its one format. */
const scoreFormatters = (format: MetricFormat) => ({
  fmt: (v: number) => formatMetricValue(v, format),
  fmtDelta: (d: number) => formatMetricDelta(d, format),
});
/** A run's score row for a scorer: the one the comparison reads. */
const scoreOf = (r: ResultRow | undefined, scorerName: string): ScoreRow | undefined =>
  r && scoreRowsOf(r).get(scorerName);
/** A scorer's value as a comparable number (booleans/pass-fail fold to 1/0). */
function scoreNumeric(s: ScoreRow | undefined): number | null {
  if (!s || s.error) return null;
  if (s.numericValue !== null) return s.numericValue;
  if (s.boolValue !== null) return s.boolValue ? 1 : 0;
  if (s.passed !== null) return s.passed ? 1 : 0;
  return null;
}
/** A scorer value as display TEXT — used for categorical (string) scorers, whose
 *  value can't fold to a number and would otherwise render as "—". */
function scoreText(s: ScoreRow | undefined, format: MetricFormat): string {
  if (!s) return "—";
  if (s.error) return "error";
  if (s.stringValue !== null) return s.stringValue;
  if (s.numericValue !== null) return formatMetricValue(s.numericValue, format);
  if (s.boolValue !== null) return s.boolValue ? "true" : "false";
  if (s.passed !== null) return s.passed ? "pass" : "fail";
  return "—";
}

// ── Cell primitives ───────────────────────────────────────────────────────

/** Truncated text that reveals its full value on hover (no click, no chrome). */
function TextValue({ text }: { text: string | null }) {
  const t = text?.trim();
  if (!t) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-full cursor-default truncate">{t}</span>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        side="bottom"
        className="max-h-[420px] w-[460px] max-w-[80vw] overflow-auto whitespace-pre-wrap break-words border bg-popover p-3 font-mono text-[12px] leading-relaxed text-popover-foreground shadow-[0_4px_12px_rgba(11,16,21,0.08)]"
      >
        {t}
      </TooltipContent>
    </Tooltip>
  );
}

/** One value per run, stacked and colour-keyed (in baseline-first display order), each
 *  named by its run for screen readers and on hover. */
function RunStack({
  values,
  align = "left",
  tooltipped = false,
}: {
  values: { runId: string; dot: string; label: string; node: React.ReactNode }[];
  align?: "left" | "right";
  /** The values carry their own tooltip, so the native title would stack a second one. */
  tooltipped?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", align === "right" && "items-end")}>
      {values.map((v) => (
        <span
          key={v.runId}
          title={tooltipped ? undefined : v.label}
          className="flex max-w-full items-center gap-1.5"
        >
          <Dot color={v.dot} />
          <span className="min-w-0 truncate">
            <RunLabel label={v.label} />
            {v.node}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * A numeric column's per-run stack: each run's value plus, for the non-baseline
 * runs, its improvement/regression delta against the baseline run.
 */
function NumericStack({
  ordered,
  baseline,
  dotFor,
  labelOf,
  get,
  fmt,
  fmtDelta,
  direction,
}: {
  ordered: RunBundle[];
  baseline: RunBundle;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  get: (b: RunBundle) => number | null;
  fmt: (n: number) => string;
  /** Formats a signed change against the baseline. */
  fmtDelta: (delta: number) => string;
  direction: ScorerDirection;
}) {
  const base = get(baseline);
  return (
    <RunStack
      align="right"
      values={ordered.map((b) => {
        const v = get(b);
        const isBaseline = b.run.id === baseline.run.id;
        const delta = !isBaseline && v !== null && base !== null ? v - base : null;
        return {
          runId: b.run.id,
          dot: dotFor(b.run.id),
          label: labelOf(b.run.id),
          node: (
            <span className="whitespace-nowrap">
              {v === null ? "—" : fmt(v)}
              {delta !== null && (
                <Delta value={delta} text={fmtDelta(delta)} direction={direction} />
              )}
            </span>
          ),
        };
      })}
    />
  );
}

/**
 * A summary cell: one line per run, baseline first, colour-keyed like the cells below. The
 * baseline's line names it instead of showing a mean: each other run's line reads
 * "baseline → candidate" for its own pair, and the baseline's mean differs from pair to
 * pair when they cover different cases.
 */
function SummaryStack({
  ordered,
  baselineId,
  dotFor,
  labelOf,
  line,
}: {
  ordered: RunBundle[];
  baselineId: string;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  /** A candidate's line, against the baseline. */
  line: (candidateRunId: string) => React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      {ordered.map(({ run }) => (
        <div key={run.id} className="flex items-start gap-1.5">
          <span className="flex h-[1lh] shrink-0 items-center">
            <Dot color={dotFor(run.id)} />
          </span>
          <span className="min-w-0 text-right">
            <RunLabel label={labelOf(run.id)} />
            {run.id === baselineId ? (
              <span className="text-muted-foreground">Baseline</span>
            ) : (
              line(run.id)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A pair's mean case latency, in the shape the summary reads. */
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

// ── The page ──────────────────────────────────────────────────────────────

export function CompareRunsView({
  projectId,
  runIds,
  baselineId,
  onChangeBaseline,
}: {
  projectId: string;
  runIds: string[];
  baselineId: string | null;
  onChangeBaseline: (baselineId: string | null) => void;
}) {
  const queries = useEvaluationRunDetails(projectId, runIds);
  const [keyword, setKeyword] = React.useState("");

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.some((q) => q.isError);

  // Stable per-run colour, keyed by selection order (not display order).
  const dotFor = React.useCallback(
    (runId: string) => RUN_DOTS[Math.max(0, runIds.indexOf(runId)) % RUN_DOTS.length],
    [runIds],
  );

  const loaded = React.useMemo<RunBundle[]>(
    () => queries.map((q) => q.data).filter((d): d is NonNullable<typeof d> => !!d),
    [queries],
  );

  // The URL's baseline, or the oldest run when it names none of these runs; runs in
  // display order (baseline first); and the union of aligned cases.
  const model = React.useMemo(() => buildCompareModel(loaded, baselineId), [loaded, baselineId]);
  const ordered = model.runs;
  const effectiveBaselineId = model.baselineRunId || null;
  const baseline = ordered[0];
  const crossDataset = model.alignment === "canonical_input";
  const datasetNames = [...new Set(ordered.map((b) => b.run.datasetName ?? "—"))];

  const crossExperiment = new Set(ordered.map((b) => b.run.evaluationName)).size > 1;

  // Rows = cases EVERY run has, in baseline order.
  const intersection = React.useMemo(
    () => model.cases.filter((c) => c.byRun.size === model.runs.length),
    [model],
  );

  const scorers = model.scorers;

  // Each candidate against the baseline, on the cases both of them have.
  const pairs = React.useMemo(() => comparePairs(model), [model]);
  const exclusions = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, pairExclusions(model, pair)])),
    [model, pairs],
  );
  const cellCounts = React.useMemo(
    () => new Map([...pairs].map(([runId, pair]) => [runId, countCellsByScorer(pair)])),
    [pairs],
  );

  // A run whose returned results fall short of its declared case count was truncated
  // by the run-detail API cap, so its aggregates/deltas are computed on a partial set.
  const truncatedRuns = React.useMemo(
    () => ordered.filter((b) => b.run.caseCount > b.results.length),
    [ordered],
  );

  // Search over any run's input / output / expected for the row.
  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return intersection;
    return intersection.filter((c) =>
      [...c.byRun.values()].some(
        (r) =>
          r.input.toLowerCase().includes(q) ||
          (r.candidateOutput ?? "").toLowerCase().includes(q) ||
          (r.expectedOutput ?? "").toLowerCase().includes(q),
      ),
    );
  }, [intersection, keyword]);

  // "#2", or "support-routing #2" when the runs span evaluations (numbers restart per one).
  const runTag = (b: RunBundle) =>
    `${crossExperiment ? `${b.run.evaluationName} ` : ""}#${b.run.runNumber}`;
  const runLabel = (b: RunBundle) => `${runTag(b)} ${b.run.candidateVersion}`;
  const labelOf = (runId: string) => {
    const b = ordered.find((x) => x.run.id === runId);
    return b ? runLabel(b) : "";
  };
  const tagOf = (runId: string) => {
    const b = ordered.find((x) => x.run.id === runId);
    return b ? runTag(b) : "";
  };

  const summaryStack = { ordered, baselineId: model.baselineRunId, dotFor, labelOf };
  const columnCount = 3 + scorers.length + 2;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col text-[12px]">
        <ProjectBreadcrumb projectId={projectId} current="Run Comparison" />

        {/* Search + baseline picker. */}
        <div className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border px-4 py-1">
          <div className="relative min-w-[12rem] max-w-md flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search..."
              className="h-8 pl-8 text-[13px]"
            />
          </div>
          {ordered.length > 0 && baseline && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">Baseline</span>
              <Select value={effectiveBaselineId ?? ""} onValueChange={(v) => onChangeBaseline(v)}>
                {/* `[&>span]:!flex` overrides the trigger's base `line-clamp-1`
                  (display:-webkit-box), which would otherwise swallow the dot. */}
                <SelectTrigger
                  className="h-8 w-auto gap-2 text-[13px] [&>span]:!flex [&>span]:items-center [&>span]:gap-2"
                  title="Baseline run"
                >
                  <span className="whitespace-nowrap">
                    <Dot color={dotFor(baseline.run.id)} />
                    {runLabel(baseline)}
                  </span>
                </SelectTrigger>
                <SelectContent align="end">
                  {ordered.map((b) => (
                    <SelectItem
                      key={b.run.id}
                      value={b.run.id}
                      className="text-[12px]"
                      icon={<Dot color={dotFor(b.run.id)} />}
                    >
                      {runLabel(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {runIds.length < 2 ? (
          <div className="p-3">
            <EmptyState>Select at least two runs to compare.</EmptyState>
          </div>
        ) : isLoading ? (
          <div className="p-3">
            <EmptyState>Comparing…</EmptyState>
          </div>
        ) : isError || ordered.length !== runIds.length || !baseline ? (
          <div className="p-3">
            <EmptyState>Couldn’t load one or more of these runs.</EmptyState>
          </div>
        ) : model.sharedByAllCount === 0 ? (
          <div className="p-3">
            <EmptyState>
              {crossDataset
                ? `These runs are on different datasets (${datasetNames.join(", ")}) and share no inputs in common.`
                : "These runs share no dataset rows — their dataset versions have no rows in common."}
            </EmptyState>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Some runs exceeded the run-detail result cap, so their columns are
                computed on a partial set — say so rather than imply full coverage. */}
            {truncatedRuns.length > 0 && (
              <div className="border-b border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
                {truncatedRuns.map((b) => runLabel(b)).join(", ")} returned only the first{" "}
                {truncatedRuns[0].results.length} of their cases (API limit), so their scores,
                latency, and cost summaries and deltas are partial.
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              <Table className="sticky-sep">
                <THead>
                  {/* Label row — grey, one line, with a divider below it. */}
                  <TRHead>
                    <Th className="min-w-[220px]">Input</Th>
                    <Th className="min-w-[220px]">Output</Th>
                    <Th className="min-w-[180px]">Expected</Th>
                    {scorers.map((s) => (
                      <Th key={s.name} className="w-[130px] text-right">
                        {s.name}
                      </Th>
                    ))}
                    <Th className="w-[120px] text-right">Latency (mean)</Th>
                    <Th className="w-[120px] text-right">Cost (mean)</Th>
                  </TRHead>
                  {/* Aggregate row — white, styled like the data cells below it. */}
                  <tr className="border-b border-border bg-background">
                    <Td />
                    <Td />
                    <Td />
                    {scorers.map((s) => (
                      <Td key={s.name} className="align-top text-[12px] tabular-nums">
                        <SummaryStack
                          {...summaryStack}
                          line={(runId) => (
                            <ScorerSummary
                              pair={pairs.get(runId)}
                              exclusions={exclusions.get(runId)}
                              counts={cellCounts.get(runId)}
                              column={s}
                              tagOf={tagOf}
                            />
                          )}
                        />
                      </Td>
                    ))}
                    <Td className="align-top text-[12px] tabular-nums">
                      <SummaryStack
                        {...summaryStack}
                        line={(runId) => (
                          <MeanSummary
                            mean={durationOf(pairs.get(runId))}
                            measure="latency"
                            fmt={formatMs}
                            fmtDelta={signedWith(formatMs)}
                          />
                        )}
                      />
                    </Td>
                    <Td className="align-top text-[12px] tabular-nums">
                      <SummaryStack
                        {...summaryStack}
                        line={(runId) => (
                          <MeanSummary
                            mean={pairs.get(runId)?.cost}
                            measure="cost"
                            fmt={formatCost}
                            fmtDelta={signedWith(formatCost)}
                          />
                        )}
                      />
                    </Td>
                  </tr>
                </THead>
                <TBody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={columnCount}>
                        <EmptyState>No rows match your search.</EmptyState>
                      </td>
                    </tr>
                  ) : (
                    visible.map((row) => (
                      <CaseTableRow
                        key={row.key}
                        row={row}
                        ordered={ordered}
                        baseline={baseline}
                        dotFor={dotFor}
                        labelOf={labelOf}
                        scorers={scorers}
                      />
                    ))
                  )}
                </TBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * One dataset row across the compared runs. Input/Expected collapse to a single
 * value when every run agrees; Output and the metric columns always stack one
 * value per run, with green/red deltas against the baseline on the metrics.
 */
function CaseTableRow({
  row,
  ordered,
  baseline,
  dotFor,
  labelOf,
  scorers,
}: {
  row: CaseRow;
  ordered: RunBundle[];
  baseline: RunBundle;
  dotFor: (runId: string) => string;
  labelOf: (runId: string) => string;
  scorers: ScorerColumn[];
}) {
  const rowOf = (b: RunBundle) => row.byRun.get(b.run.id);

  // Collapse a per-run string column to one value when the runs agree. `sameOn` decides
  // agreement (default: the raw text); the displayed value is still the raw text.
  const collapsed = (
    get: (r: ResultRow | undefined) => string | null,
    sameOn: (r: ResultRow | undefined) => string = (r) => get(r) ?? "—",
  ) => {
    const keys = new Set(ordered.map((b) => sameOn(rowOf(b))));
    return keys.size <= 1 ? (get(rowOf(ordered[0])) ?? "—") : null;
  };
  // Input collapses on the ALIGNING key, not the raw text: rows aligned across datasets
  // by `canonicalInputKey` (differing JSON key order, or legacy plaintext vs JSON-encoded)
  // are the "same input" and render once, while genuinely edited same-dataset inputs stay
  // stacked.
  const collapsedInput = collapsed(
    (r) => r?.input ?? null,
    (r) => (r ? inputKeyOf(r) : "—"),
  );
  const collapsedExpected = collapsed((r) => r?.expectedOutput ?? null);

  const textStack = (get: (r: ResultRow | undefined) => string | null) => (
    <RunStack
      tooltipped
      values={ordered.map((b) => ({
        runId: b.run.id,
        dot: dotFor(b.run.id),
        label: labelOf(b.run.id),
        node: <TextValue text={get(rowOf(b))} />,
      }))}
    />
  );

  return (
    <TR>
      <Td className="max-w-[320px] align-top">
        {collapsedInput !== null ? (
          <TextValue text={collapsedInput} />
        ) : (
          textStack((r) => r?.input ?? null)
        )}
      </Td>
      <Td className="max-w-[320px] align-top">{textStack((r) => r?.candidateOutput ?? null)}</Td>
      <Td className="max-w-[240px] align-top text-muted-foreground">
        {collapsedExpected !== null ? (
          <TextValue text={collapsedExpected} />
        ) : (
          textStack((r) => r?.expectedOutput ?? null)
        )}
      </Td>
      {scorers.map((s) =>
        s.valueType === "categorical" ? (
          // Categorical scorer — show each run's text value (no numeric delta).
          <Td key={s.name} className="align-top text-[12px]">
            <RunStack
              align="right"
              values={ordered.map((b) => ({
                runId: b.run.id,
                dot: dotFor(b.run.id),
                label: labelOf(b.run.id),
                node: (
                  <span className="whitespace-nowrap">
                    {scoreText(scoreOf(rowOf(b), s.name), s.format)}
                  </span>
                ),
              }))}
            />
          </Td>
        ) : (
          <Td key={s.name} className="align-top text-[12px] tabular-nums">
            <NumericStack
              ordered={ordered}
              baseline={baseline}
              dotFor={dotFor}
              labelOf={labelOf}
              get={(b) => scoreNumeric(scoreOf(rowOf(b), s.name))}
              {...scoreFormatters(s.format)}
              direction={s.direction}
            />
          </Td>
        ),
      )}
      <Td className="align-top text-[12px] tabular-nums">
        <NumericStack
          ordered={ordered}
          baseline={baseline}
          dotFor={dotFor}
          labelOf={labelOf}
          get={(b) => rowOf(b)?.durationMs ?? null}
          fmt={formatMs}
          fmtDelta={signedWith(formatMs)}
          direction="lower_is_better"
        />
      </Td>
      <Td className="align-top text-[12px] tabular-nums">
        <NumericStack
          ordered={ordered}
          baseline={baseline}
          dotFor={dotFor}
          labelOf={labelOf}
          get={(b) => rowOf(b)?.cost ?? null}
          fmt={formatCost}
          fmtDelta={signedWith(formatCost)}
          direction="lower_is_better"
        />
      </Td>
    </TR>
  );
}
