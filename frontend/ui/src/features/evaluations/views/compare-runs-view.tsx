"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { EmptyState } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { pctFraction, changeSentiment, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import { cn } from "@/lib/utils";
import { canonicalInputKey } from "@/lib/eval/json-value";
import { useEvaluationRunDetails } from "../hooks";
import type { ResultRow, RunDetail, ScoreRow } from "../types";

// A run comparison is N runs (2+) lined up case-by-case, anchored on the baseline run.
// Alignment is decided per run against the baseline's DATASET (compared by `datasetId`,
// the stable PK — never `datasetName`, which is display-only and freely renamed): a run
// on the baseline's dataset aligns by `testCaseId` (the dataset-row id, stable across
// input edits), and a run on a DIFFERENT dataset — whose case ids are dataset-scoped and
// never match — aligns by shared (canonical) input instead. So a same-dataset pair keeps
// exact row identity even when other runs in the selection span datasets. Each metric
// column stacks one value per run, colour-keyed to the baseline picker; against the chosen
// baseline every other run also shows a green/red improvement/regression delta — à la a
// side-by-side experiment diff. Row drill-in is postponed (cells expand to full text).

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
/** A [0,1] score reads as a percentage; anything else as a trimmed number. */
const fmtScoreNumber = (v: number) =>
  v >= 0 && v <= 1 ? pctFraction(v) : Number.isInteger(v) ? String(v) : v.toFixed(2);
const fmtMs = (n: number) => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);
const fmtCost = (n: number) => `$${n.toFixed(4)}`;
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
function scoreText(s: ScoreRow | undefined): string {
  if (!s) return "—";
  if (s.error) return "error";
  if (s.stringValue !== null) return s.stringValue;
  if (s.numericValue !== null) return fmtScoreNumber(s.numericValue);
  if (s.boolValue !== null) return s.boolValue ? "true" : "false";
  if (s.passed !== null) return s.passed ? "pass" : "fail";
  return "—";
}
/** True when a scorer carries string values (categorical) rather than numbers. */
function isCategoricalScore(s: ScoreRow): boolean {
  return (
    s.stringValue !== null && s.numericValue === null && s.boolValue === null && s.passed === null
  );
}
function meanNumeric(vals: (number | null)[]): number | null {
  const nums = vals.filter((v): v is number => v !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// A run plus two baseline-INDEPENDENT lookups over its own results, keep-first on a
// duplicate key so a repeated case never silently drops a row from display/aggregates:
//  · byTestCase — keyed by dataset-row id, for a run on the baseline's dataset;
//  · byInput    — keyed by canonical input, for a run on a different dataset.
// Which lookup a run is read through is decided per baseline, when its `byCase` is built.
type RunBundle = {
  run: RunDetail;
  results: ResultRow[];
  byTestCase: Map<string, ResultRow>;
  byInput: Map<string, ResultRow>;
};
// A run re-projected against the chosen baseline: `byCase` maps a baseline row key (the
// baseline's `testCaseId`) to this run's aligned result — by testCaseId when the run is
// on the baseline's dataset, else by canonical input. This is what the table consumes.
type Bundle = RunBundle & { byCase: Map<string, ResultRow> };

/** Keep-first insertion into a Map — a duplicate key keeps the earliest row. */
function keepFirst(rows: ResultRow[], keyOf: (r: ResultRow) => string): Map<string, ResultRow> {
  return rows.reduce(
    (map, r) => (map.has(keyOf(r)) ? map : map.set(keyOf(r), r)),
    new Map<string, ResultRow>(),
  );
}

// ── Cell primitives ───────────────────────────────────────────────────────

/** One coloured dot for a run. */
function Dot({ color }: { color: string }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} aria-hidden />;
}

/** A signed, direction-aware delta vs the baseline (green = better, red = worse). */
function Delta({
  value,
  fmt,
  higherIsBetter,
}: {
  value: number;
  fmt: (n: number) => string;
  higherIsBetter: boolean;
}) {
  if (value === 0) return null;
  return (
    <span className={cn("ml-1", SENTIMENT_CLASS[changeSentiment(value, higherIsBetter)])}>
      {value > 0 ? "+" : "−"}
      {fmt(Math.abs(value))}
    </span>
  );
}

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
        className="max-h-[420px] w-[460px] max-w-[80vw] overflow-auto whitespace-pre-wrap break-words border bg-popover p-3 font-mono text-[12px] leading-relaxed text-popover-foreground shadow-md"
      >
        {t}
      </TooltipContent>
    </Tooltip>
  );
}

/** One value per run, stacked and colour-keyed (in baseline-first display order). */
function RunStack({
  values,
  align = "left",
}: {
  values: { runId: string; dot: string; node: React.ReactNode }[];
  align?: "left" | "right";
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", align === "right" && "items-end")}>
      {values.map((v) => (
        <span key={v.runId} className="flex max-w-full items-center gap-1.5">
          <Dot color={v.dot} />
          <span className="min-w-0 truncate">{v.node}</span>
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
  get,
  fmt,
  higherIsBetter,
}: {
  ordered: Bundle[];
  baseline: Bundle;
  dotFor: (runId: string) => string;
  get: (b: Bundle) => number | null;
  fmt: (n: number) => string;
  higherIsBetter: boolean;
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
          node: (
            <span className="whitespace-nowrap">
              {v === null ? "—" : fmt(v)}
              {delta !== null && <Delta value={delta} fmt={fmt} higherIsBetter={higherIsBetter} />}
            </span>
          ),
        };
      })}
    />
  );
}

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

  // The loaded run+results, each with its two baseline-INDEPENDENT lookups built once
  // (keep-first). Which lookup a run is read through is decided later, per baseline, so
  // re-picking the baseline never rebuilds these maps (no re-canonicalization).
  const loaded = React.useMemo<RunBundle[]>(
    () =>
      queries
        .map((q) => q.data)
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => ({
          run: d.run,
          results: d.results,
          byTestCase: keepFirst(d.results, (r) => r.testCaseId),
          byInput: keepFirst(d.results, (r) => canonicalInputKey(r.input)),
        })),
    [queries],
  );

  // One alignment descriptor, derived from the STABLE `datasetId` (never the mutable,
  // non-unique `datasetName`). `crossDataset` is true only when the selection genuinely
  // spans datasets; dataset names are for display copy only. Consumed in three places:
  // the empty-state copy, the banner, and (via `byCase` below) the alignment itself.
  const alignment = React.useMemo(() => {
    const datasetIds = new Set(loaded.map((b) => b.run.datasetId));
    return {
      crossDataset: datasetIds.size > 1,
      datasetNames: [...new Set(loaded.map((b) => b.run.datasetName ?? "—"))],
    };
  }, [loaded]);
  const { crossDataset, datasetNames } = alignment;

  // Baseline-first display order (baseline, then by run number). Baseline-independent
  // maps are carried through unchanged — only the ORDER depends on the baseline.
  const orderedBundles = React.useMemo<RunBundle[]>(
    () =>
      [...loaded].sort((a, b) => {
        if (a.run.id === baselineId) return -1;
        if (b.run.id === baselineId) return 1;
        return a.run.runNumber - b.run.runNumber;
      }),
    [loaded, baselineId],
  );

  const baselineBundle = orderedBundles.find((b) => b.run.id === baselineId) ?? orderedBundles[0];

  // Project every run against the baseline: a run on the baseline's dataset aligns by
  // `testCaseId` (stable across input edits), any other run aligns by canonical input.
  // Row identity is the baseline row's `testCaseId`, so all runs' `byCase` share one key
  // space and a same-dataset pair keeps exact row identity even alongside cross-dataset
  // runs in the same selection.
  const ordered = React.useMemo<Bundle[]>(() => {
    if (!baselineBundle) return [];
    // Cross-dataset alignment keys on canonical input, so a baseline that repeats an input
    // across dataset rows must be deduped by input first (`byInput`) — otherwise the shared
    // input renders once per baseline row and double-counts in the aggregates. Same-dataset
    // comparisons stay on `byTestCase`, preserving exact row identity across input edits.
    const baselineRows = crossDataset
      ? [...baselineBundle.byInput.values()]
      : [...baselineBundle.byTestCase.values()];
    return orderedBundles.map((b) => {
      const sameDataset = b.run.datasetId === baselineBundle.run.datasetId;
      const byCase = new Map<string, ResultRow>();
      for (const br of baselineRows) {
        const match = sameDataset
          ? b.byTestCase.get(br.testCaseId)
          : b.byInput.get(canonicalInputKey(br.input));
        if (match) byCase.set(br.testCaseId, match);
      }
      return { ...b, byCase };
    });
  }, [orderedBundles, baselineBundle, crossDataset]);

  const baseline = ordered.find((b) => b.run.id === baselineId) ?? ordered[0];

  const crossExperiment = new Set(ordered.map((b) => b.run.evaluationName)).size > 1;

  // Rows = baseline row keys present in EVERY run's aligned view, in baseline order.
  // Baseline rows are already keep-first-deduped (byTestCase), and each run's `byCase`
  // is keyed by that same baseline `testCaseId`, so no further de-duplication is needed.
  const intersection = React.useMemo(() => {
    if (ordered.length === 0) return [];
    return [...ordered[0].byCase.keys()].filter((id) => ordered.every((b) => b.byCase.has(id)));
  }, [ordered]);

  // Union of scorer names across the compared runs.
  const scorerNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const b of ordered)
      for (const r of b.results) for (const s of r.scores) names.add(s.scorerName);
    return [...names].sort();
  }, [ordered]);

  // Per-scorer semantics: its direction (so a lower-is-better scorer colours its
  // deltas correctly) and whether it's categorical (rendered as text, no delta).
  // Direction comes from the run's declared scorer aggregate; categorical is detected
  // from the raw values so runs without a comparison block are still covered.
  const scorerMeta = React.useMemo(() => {
    const higher = new Map<string, boolean>();
    const categorical = new Set<string>();
    for (const b of ordered) {
      for (const s of b.run.comparison?.scorers ?? []) {
        if (!higher.has(s.name)) higher.set(s.name, s.direction !== "lower_is_better");
        if (s.valueType === "categorical") categorical.add(s.name);
      }
      for (const r of b.results)
        for (const s of r.scores) if (isCategoricalScore(s)) categorical.add(s.scorerName);
    }
    return { higher, categorical };
  }, [ordered]);
  const higherFor = (name: string) => scorerMeta.higher.get(name) ?? true;
  const isCategorical = (name: string) => scorerMeta.categorical.has(name);

  // A run whose returned results fall short of its declared case count was truncated
  // by the run-detail API cap, so its aggregates/deltas are computed on a partial set.
  const truncatedRuns = React.useMemo(
    () => ordered.filter((b) => b.run.caseCount > b.results.length),
    [ordered],
  );

  // Per-run aggregates over the intersection (the compared population).
  const agg = React.useMemo(() => {
    const scorer = new Map<string, Map<string, number | null>>();
    for (const name of scorerNames) {
      const perRun = new Map<string, number | null>();
      for (const b of ordered) {
        perRun.set(
          b.run.id,
          meanNumeric(
            intersection.map((id) =>
              scoreNumeric(b.byCase.get(id)?.scores.find((s) => s.scorerName === name)),
            ),
          ),
        );
      }
      scorer.set(name, perRun);
    }
    // Duration and Cost aggregate to TOTALS (like the Experiments list's columns),
    // over the compared population; scorers aggregate to means above.
    const sumOver = (get: (r: ResultRow | undefined) => number | null) => (b: Bundle) => {
      const vals = intersection
        .map((id) => get(b.byCase.get(id)))
        .filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
    };
    const duration = new Map<string, number | null>();
    const cost = new Map<string, number | null>();
    for (const b of ordered) {
      duration.set(b.run.id, sumOver((r) => r?.durationMs ?? null)(b));
      cost.set(b.run.id, sumOver((r) => r?.cost ?? null)(b));
    }
    return { scorer, duration, cost };
  }, [ordered, scorerNames, intersection]);

  // Search over any run's input / output / expected for the row.
  const visible = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return intersection;
    return intersection.filter((id) =>
      ordered.some((b) => {
        const r = b.byCase.get(id);
        return (
          (r?.input ?? "").toLowerCase().includes(q) ||
          (r?.candidateOutput ?? "").toLowerCase().includes(q) ||
          (r?.expectedOutput ?? "").toLowerCase().includes(q)
        );
      }),
    );
  }, [intersection, keyword, ordered]);

  const runLabel = (b: Bundle) =>
    `${crossExperiment ? `${b.run.evaluationName} ` : ""}#${b.run.runNumber} · ${b.run.candidateVersion}`;

  const columnCount = 3 + scorerNames.length + 2;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col text-[12px]">
        <ProjectBreadcrumb projectId={projectId} current="Run Comparison" />

        {/* Search + baseline picker. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-1.5">
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
              <Select value={baselineId ?? ""} onValueChange={(v) => onChangeBaseline(v)}>
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
        ) : intersection.length === 0 ? (
          <div className="p-3">
            <EmptyState>
              {crossDataset
                ? `These runs are on different datasets (${datasetNames.join(", ")}) and share no inputs in common.`
                : "These runs share no dataset rows — their dataset versions have no rows in common."}
            </EmptyState>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Cross-dataset runs don't share dataset-scoped case ids, so cases are
                lined up by their (canonical) input instead — say so, don't block. */}
            {crossDataset && (
              <div className="border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                These runs are on different datasets ({datasetNames.join(", ")}), so cases are
                aligned by shared input rather than by dataset row.
              </div>
            )}
            {/* Some runs exceeded the run-detail result cap, so their columns are
                computed on a partial set — say so rather than imply full coverage. */}
            {truncatedRuns.length > 0 && (
              <div className="border-b border-amber-400/60 bg-amber-100/50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                {truncatedRuns.map((b) => runLabel(b)).join(", ")} returned only the first{" "}
                {truncatedRuns[0].results.length} of their cases (API limit), so their scores,
                duration, and cost aggregates and deltas are partial.
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              <Table>
                <THead>
                  {/* Label row — grey, one line, with a divider below it. */}
                  <TRHead>
                    <Th className="min-w-[220px]">Input</Th>
                    <Th className="min-w-[220px]">Output</Th>
                    <Th className="min-w-[180px]">Expected</Th>
                    {scorerNames.map((name) => (
                      <Th key={name} className="w-[130px] text-right font-mono">
                        {name}
                      </Th>
                    ))}
                    <Th className="w-[120px] text-right">Duration</Th>
                    <Th className="w-[120px] text-right">Cost</Th>
                  </TRHead>
                  {/* Aggregate row — white, styled like the data cells below it. */}
                  <tr className="border-b border-border bg-background">
                    <Td />
                    <Td />
                    <Td />
                    {scorerNames.map((name) => (
                      <Td key={name} className="text-[10px] tabular-nums">
                        <NumericStack
                          ordered={ordered}
                          baseline={baseline}
                          dotFor={dotFor}
                          get={(b) => agg.scorer.get(name)?.get(b.run.id) ?? null}
                          fmt={fmtScoreNumber}
                          higherIsBetter={higherFor(name)}
                        />
                      </Td>
                    ))}
                    <Td className="text-[10px] tabular-nums">
                      <NumericStack
                        ordered={ordered}
                        baseline={baseline}
                        dotFor={dotFor}
                        get={(b) => agg.duration.get(b.run.id) ?? null}
                        fmt={fmtMs}
                        higherIsBetter={false}
                      />
                    </Td>
                    <Td className="text-[10px] tabular-nums">
                      <NumericStack
                        ordered={ordered}
                        baseline={baseline}
                        dotFor={dotFor}
                        get={(b) => agg.cost.get(b.run.id) ?? null}
                        fmt={fmtCost}
                        higherIsBetter={false}
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
                    visible.map((id) => (
                      <CaseRow
                        key={id}
                        caseId={id}
                        ordered={ordered}
                        baseline={baseline}
                        dotFor={dotFor}
                        scorerNames={scorerNames}
                        higherFor={higherFor}
                        isCategorical={isCategorical}
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
function CaseRow({
  caseId,
  ordered,
  baseline,
  dotFor,
  scorerNames,
  higherFor,
  isCategorical,
}: {
  caseId: string;
  ordered: Bundle[];
  baseline: Bundle;
  dotFor: (runId: string) => string;
  scorerNames: string[];
  higherFor: (name: string) => boolean;
  isCategorical: (name: string) => boolean;
}) {
  const rowOf = (b: Bundle) => b.byCase.get(caseId);

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
  // are the "same input" and render once — matching the "aligned by shared input" banner —
  // while genuinely edited same-dataset inputs stay stacked.
  const collapsedInput = collapsed(
    (r) => r?.input ?? null,
    (r) => (r ? canonicalInputKey(r.input) : "—"),
  );
  const collapsedExpected = collapsed((r) => r?.expectedOutput ?? null);

  const textStack = (get: (r: ResultRow | undefined) => string | null) => (
    <RunStack
      values={ordered.map((b) => ({
        runId: b.run.id,
        dot: dotFor(b.run.id),
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
      {scorerNames.map((name) =>
        isCategorical(name) ? (
          // Categorical scorer — show each run's text value (no numeric delta).
          <Td key={name} className="align-top text-[11px]">
            <RunStack
              align="right"
              values={ordered.map((b) => ({
                runId: b.run.id,
                dot: dotFor(b.run.id),
                node: (
                  <span className="whitespace-nowrap">
                    {scoreText(rowOf(b)?.scores.find((s) => s.scorerName === name))}
                  </span>
                ),
              }))}
            />
          </Td>
        ) : (
          <Td key={name} className="align-top text-[11px] tabular-nums">
            <NumericStack
              ordered={ordered}
              baseline={baseline}
              dotFor={dotFor}
              get={(b) => scoreNumeric(rowOf(b)?.scores.find((s) => s.scorerName === name))}
              fmt={fmtScoreNumber}
              higherIsBetter={higherFor(name)}
            />
          </Td>
        ),
      )}
      <Td className="align-top text-[11px] tabular-nums">
        <NumericStack
          ordered={ordered}
          baseline={baseline}
          dotFor={dotFor}
          get={(b) => rowOf(b)?.durationMs ?? null}
          fmt={fmtMs}
          higherIsBetter={false}
        />
      </Td>
      <Td className="align-top text-[11px] tabular-nums">
        <NumericStack
          ordered={ordered}
          baseline={baseline}
          dotFor={dotFor}
          get={(b) => rowOf(b)?.cost ?? null}
          fmt={fmtCost}
          higherIsBetter={false}
        />
      </Td>
    </TR>
  );
}
