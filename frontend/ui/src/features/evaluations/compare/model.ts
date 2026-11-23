/**
 * The run comparison page's data: N runs lined up case by case against one baseline run,
 * and every baseline–candidate pair compared by the shared comparison engine.
 *
 * Alignment is decided per run against the baseline's DATASET (by `datasetId`, the stable
 * PK; never `datasetName`, which is display-only and freely renamed):
 *  · a run on the baseline's dataset aligns by `testCaseId`, the dataset-row id, which stays
 *    stable across input edits;
 *  · a run on a different dataset, whose case ids are dataset-scoped and never match, aligns
 *    by canonical input with a plain lookup, so one case for a shared input fills every row
 *    carrying that input.
 * Duplicates resolve keep-first within a run: a repeated case id only happens in a malformed
 * run, but a cross-dataset run that measured one input several times contributes only its
 * first such case. Duplicate inputs on the baseline's dataset keep distinct ids, so they
 * stay distinct rows. Occurrences are never paired across datasets: an `occurrence` is a
 * slot inside one dataset's history (a delete leaves a gap), not a portable ordinal.
 *
 * Rows are the union of every run's cases, so each pair can use exactly the cases both of
 * its runs have, whatever the other selected runs hold.
 */
import {
  compareRuns,
  defaultDirection,
  readScore,
  type ComparisonResult,
  type CountBlock,
  type ComparisonScorerMeta,
  type ResultComparison,
  type RunComparison,
  type ScorerCellComparison,
  type ScorerDirection,
  type ScorerValueType,
} from "@/lib/eval/comparison";
import { parseScorers, toComparisonResults, toComparisonRun } from "@/lib/eval/comparison-db";
import { canonicalInputKey } from "@/lib/eval/json-value";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import type { ResultRow, RunDetail } from "../types";
import { isCompared, scoreRowsOf, scorerCellState, type CellFailure } from "./cell-state";
import { inferMetricFormat, type MetricFormat } from "./metric-format";
import { oldestFirst } from "./run-order";

export type AlignmentMode = "case_id" | "canonical_input";

export interface RunBundle {
  run: RunDetail;
  results: ResultRow[];
}

/** One aligned case (table row) across all selected runs. */
export interface CaseRow {
  /** `id:<testCaseId>` for a case on the baseline's dataset, `input:<canonical input>` for
   *  a cross-dataset case whose input no such case carries. */
  key: string;
  /** runId → that run's result; absent = the run has no result for this case. */
  byRun: ReadonlyMap<string, ResultRow>;
}

/** One baseline–candidate pair, computed by `compareRuns` over the aligned keys. */
export interface PairComparison {
  candidateRunId: string;
  comparison: RunComparison;
  /** Keyed by `CaseRow.key`. */
  byCase: ReadonlyMap<string, ResultComparison>;
  /** The engine has no cost block, so the paired cost mean is computed here the same way
   *  as its duration block: over cases where both runs reported a cost. */
  cost: {
    baselineMean: number | null;
    candidateMean: number | null;
    delta: number | null;
    pairedCount: number;
  };
}

export interface ScorerColumn {
  name: string;
  valueType: ScorerValueType;
  direction: ScorerDirection;
  format: MetricFormat;
}

export interface CompareModel {
  /** Display order: baseline first, then oldest to newest. */
  runs: RunBundle[];
  /** Empty only when there are no runs. */
  baselineRunId: string;
  /** `canonical_input` as soon as any run is on a different dataset than the baseline. */
  alignment: AlignmentMode;
  /** The union of cases across runs. */
  cases: CaseRow[];
  /** Cases present in every run. */
  sharedByAllCount: number;
  scorers: ScorerColumn[];
}

// Canonicalizing an input parses and re-serializes it; results are immutable query data,
// so remember the key per row and re-picking the baseline never canonicalizes again.
const inputKeys = new WeakMap<ResultRow, string>();
/** A result's input as aligned across datasets (`canonicalInputKey`), worked out once per
 *  result. */
export function inputKeyOf(r: ResultRow): string {
  let key = inputKeys.get(r);
  if (key === undefined) {
    key = canonicalInputKey(r.input);
    inputKeys.set(r, key);
  }
  return key;
}

const expectedKeys = new WeakMap<ResultRow, string>();
/** Whether two results expect the same output, by the text a value diff reads
 *  (`normalizeForDiff`), so key order, spacing or a JSON-encoded copy don't split one
 *  expected output in two. None and an empty one stay apart. Worked out once per result. */
export function expectedKeyOf(r: ResultRow): string {
  let key = expectedKeys.get(r);
  if (key === undefined) {
    key = r.expectedOutput === null ? "" : `v:${normalizeForDiff(r.expectedOutput)}`;
    expectedKeys.set(r, key);
  }
  return key;
}

/** Keep-first insertion: a duplicate key keeps the earliest row. */
function keepFirst(rows: ResultRow[], keyOf: (r: ResultRow) => string): Map<string, ResultRow> {
  const map = new Map<string, ResultRow>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!map.has(key)) map.set(key, r);
  }
  return map;
}

/** One column per scorer any run reported. Declared policy wins, each field from the
 *  newest run that declares it: an older SDK recorded scorers as bare `{ name, version }`,
 *  which must not hide a direction a newer run declares. Otherwise the type comes from the
 *  values (any text value makes it categorical) and the direction defaults. The format
 *  comes from every number any run recorded for it, true/false counting as 1/0. */
function scorerColumns(runsOldestFirst: RunBundle[]): ScorerColumn[] {
  const declared = new Map<string, Pick<ComparisonScorerMeta, "valueType" | "direction">>();
  for (const b of runsOldestFirst) {
    // A declaration that conflicts within one run falls back to an older run's field.
    for (const meta of parseScorers(b.run.scorers)) {
      const older = declared.get(meta.name);
      declared.set(meta.name, {
        valueType: meta.valueType ?? older?.valueType ?? null,
        direction: meta.direction ?? older?.direction ?? null,
      });
    }
  }
  const observed = new Map<string, { kinds: Set<ScorerValueType>; numbers: number[] }>();
  for (const b of runsOldestFirst) {
    for (const r of b.results) {
      // One score per scorer per result (the latest version), as the aggregates use, so a
      // superseded row can't change a column's format.
      for (const s of scoreRowsOf(r).values()) {
        const seen = observed.get(s.scorerName) ?? { kinds: new Set(), numbers: [] };
        observed.set(s.scorerName, seen);
        const v = readScore(s);
        if (v.kind !== "value") continue;
        seen.kinds.add(v.valueType);
        if (typeof v.value === "boolean") seen.numbers.push(v.value ? 1 : 0);
        else if (typeof v.value === "number" && Number.isFinite(v.value)) {
          seen.numbers.push(v.value);
        }
      }
    }
  }
  return [...observed.keys()].sort().map((name) => {
    const { kinds, numbers } = observed.get(name)!;
    const meta = declared.get(name);
    const onlyBooleans = kinds.size === 1 && kinds.has("boolean");
    const inferred: ScorerValueType = onlyBooleans ? "boolean" : "numeric";
    const valueType: ScorerValueType = kinds.has("categorical")
      ? "categorical"
      : (meta?.valueType ?? inferred);
    return {
      name,
      valueType,
      direction: meta?.direction ?? defaultDirection(valueType),
      format: inferMetricFormat(valueType, numbers),
    };
  });
}

export function buildCompareModel(
  bundles: RunBundle[],
  baselineRunId: string | null,
): CompareModel {
  const byAge = [...bundles].sort((a, b) => oldestFirst(a.run, b.run));
  const baseline = byAge.find((b) => b.run.id === baselineRunId) ?? byAge[0];
  if (!baseline) {
    return {
      runs: [],
      baselineRunId: "",
      alignment: "case_id",
      cases: [],
      sharedByAllCount: 0,
      scorers: [],
    };
  }
  const runs = [baseline, ...byAge.filter((b) => b !== baseline)];
  const onBaselineDataset = (b: RunBundle) => b.run.datasetId === baseline.run.datasetId;

  const rows = new Map<string, { key: string; byRun: Map<string, ResultRow> }>();
  const rowAt = (key: string) => {
    let row = rows.get(key);
    if (!row) {
      row = { key, byRun: new Map() };
      rows.set(key, row);
    }
    return row;
  };

  // Case-id rows, from every run on the baseline's dataset (the baseline first). A row's
  // input is the input of the run that first brought it, the baseline for its own rows.
  const idRowsByInput = new Map<string, ReturnType<typeof rowAt>[]>();
  for (const b of runs.filter(onBaselineDataset)) {
    for (const [id, r] of keepFirst(b.results, (x) => x.testCaseId)) {
      const key = `id:${id}`;
      const isNew = !rows.has(key);
      const row = rowAt(key);
      if (isNew) {
        const input = inputKeyOf(r);
        idRowsByInput.set(input, [...(idRowsByInput.get(input) ?? []), row]);
      }
      row.byRun.set(b.run.id, r);
    }
  }
  // Cross-dataset runs fill every case-id row carrying the input, else an input row.
  for (const b of runs.filter((x) => !onBaselineDataset(x))) {
    for (const [input, r] of keepFirst(b.results, inputKeyOf)) {
      for (const row of idRowsByInput.get(input) ?? [rowAt(`input:${input}`)]) {
        row.byRun.set(b.run.id, r);
      }
    }
  }

  const cases: CaseRow[] = [...rows.values()];
  return {
    runs,
    baselineRunId: baseline.run.id,
    alignment: runs.every(onBaselineDataset) ? "case_id" : "canonical_input",
    cases,
    sharedByAllCount: cases.filter((c) => c.byRun.size === runs.length).length,
    scorers: scorerColumns(byAge),
  };
}

function pairedCost(cases: CaseRow[], baselineRunId: string, candidateRunId: string) {
  let baseSum = 0;
  let candSum = 0;
  let n = 0;
  for (const c of cases) {
    const base = c.byRun.get(baselineRunId)?.cost;
    const cand = c.byRun.get(candidateRunId)?.cost;
    if (base == null || cand == null) continue;
    baseSum += base;
    candSum += cand;
    n += 1;
  }
  return {
    baselineMean: n > 0 ? baseSum / n : null,
    candidateMean: n > 0 ? candSum / n : null,
    delta: n > 0 ? (candSum - baseSum) / n : null,
    pairedCount: n,
  };
}

/** Pair summaries restricted to `keys` (all cases when omitted), keyed by candidate run id.
 *  Each pair uses only the cases both of its runs have. */
export function comparePairs(
  model: CompareModel,
  keys?: ReadonlySet<string>,
): Map<string, PairComparison> {
  const pairs = new Map<string, PairComparison>();
  const baseline = model.runs.find((b) => b.run.id === model.baselineRunId);
  if (!baseline) return pairs;
  const cases = keys ? model.cases.filter((c) => keys.has(c.key)) : model.cases;
  // The engine pairs by `testCaseId`; hand it each run's aligned results under the row key.
  const resultsOf = (runId: string): ComparisonResult[] =>
    toComparisonResults(
      cases.flatMap((c) => {
        const r = c.byRun.get(runId);
        return r ? [{ ...r, testCaseId: c.key }] : [];
      }),
    );
  // One policy per column for both sides, so a direction declared on only one run can't
  // make the same column read differently from pair to pair.
  const policy: ComparisonScorerMeta[] = model.scorers.map(({ name, valueType, direction }) => ({
    name,
    version: "",
    valueType,
    direction,
  }));
  const baselineRun = { ...toComparisonRun(baseline.run), scorers: policy };
  const baselineResults = resultsOf(baseline.run.id);
  for (const candidate of model.runs) {
    if (candidate === baseline) continue;
    const { comparison, results } = compareRuns({
      candidate: { ...toComparisonRun(candidate.run), scorers: policy },
      candidateResults: resultsOf(candidate.run.id),
      baseline: baselineRun,
      baselineResults,
    });
    pairs.set(candidate.run.id, {
      candidateRunId: candidate.run.id,
      comparison,
      byCase: new Map(results.map((r) => [r.testCaseId, r])),
      cost: pairedCost(cases, baseline.run.id, candidate.run.id),
    });
  }
  return pairs;
}

/** Why a case either run of a pair has is not in a scorer's paired count. */
export type ExclusionReason = CellFailure | "version_mismatch" | "type_mismatch";

export interface Exclusion {
  reason: ExclusionReason;
  /** The run it happened in; null when it is both runs, or the pair itself (a scorer
   *  version or value type that changed between them). */
  runId: string | null;
  count: number;
}

const EXCLUSION_ORDER: readonly ExclusionReason[] = [
  "no_result",
  "task_error",
  "scorer_error",
  "not_scored",
  "version_mismatch",
  "type_mismatch",
];

// When the two runs fail differently, the case counts once, under the more basic failure:
// a missing case, then a failed task, then a missing score before a failed one (the order
// the comparison engine checks them in).
const FAILURE_RANK: Record<CellFailure, number> = {
  no_result: 0,
  task_error: 1,
  not_scored: 2,
  scorer_error: 3,
};

/** Why a scorer cell is not in the pair's paired count, read off each run's cell state so
 *  the count and the table give the same reason; null when the cell was compared. */
export function exclusionOf(
  cell: ScorerCellComparison | undefined,
  scorerName: string,
  base: ResultRow | undefined,
  cand: ResultRow | undefined,
  baselineRunId: string,
  candidateRunId: string,
): Omit<Exclusion, "count"> | null {
  if (isCompared(cell)) return null;
  if (cell?.reason === "version_mismatch" || cell?.reason === "type_mismatch") {
    return { reason: cell.reason, runId: null };
  }
  const failure = (r: ResultRow | undefined): CellFailure | null => {
    const state = scorerCellState(r, scorerName);
    return state.kind === "value" ? null : state.kind;
  };
  const b = failure(base);
  const c = failure(cand);
  if (!b) {
    // With no failure on either side, both recorded a value the engine couldn't compare
    // (a non-finite number).
    return c ? { reason: c, runId: candidateRunId } : { reason: "not_scored", runId: null };
  }
  if (!c) return { reason: b, runId: baselineRunId };
  if (b === c) return { reason: b, runId: null };
  return FAILURE_RANK[b] < FAILURE_RANK[c]
    ? { reason: b, runId: baselineRunId }
    : { reason: c, runId: candidateRunId };
}

/** Per scorer, the pair's cases left out of its paired count, counted by reason and run
 *  (baseline first, then candidate, then both). */
export function pairExclusions(
  model: CompareModel,
  pair: PairComparison,
): Map<string, Exclusion[]> {
  const { baselineRunId } = model;
  const { candidateRunId } = pair;
  const rowByKey = new Map(model.cases.map((c) => [c.key, c]));
  const tallies = new Map(model.scorers.map((s) => [s.name, new Map<string, Exclusion>()]));
  for (const [key, rc] of pair.byCase) {
    const row = rowByKey.get(key);
    const base = row?.byRun.get(baselineRunId);
    const cand = row?.byRun.get(candidateRunId);
    for (const [name, tally] of tallies) {
      const cell = rc.scorerCells.find((c) => c.scorerName === name);
      const why = exclusionOf(cell, name, base, cand, baselineRunId, candidateRunId);
      if (!why) continue;
      const id = `${why.reason}:${why.runId}`;
      const entry = tally.get(id) ?? { ...why, count: 0 };
      entry.count += 1;
      tally.set(id, entry);
    }
  }
  const runRank = (runId: string | null) =>
    runId === baselineRunId ? 0 : runId === candidateRunId ? 1 : 2;
  return new Map(
    [...tallies].map(([name, tally]) => [
      name,
      [...tally.values()].sort(
        (a, b) =>
          EXCLUSION_ORDER.indexOf(a.reason) - EXCLUSION_ORDER.indexOf(b.reason) ||
          runRank(a.runId) - runRank(b.runId),
      ),
    ]),
  );
}

/** The pair's case cells per scorer, by classification — `scoreCellCounts`, split by
 *  scorer. */
export function countCellsByScorer(pair: PairComparison): Map<string, CountBlock> {
  const counts = new Map<string, CountBlock>();
  for (const rc of pair.byCase.values()) {
    for (const cell of rc.scorerCells) {
      const block = counts.get(cell.scorerName) ?? {
        improved: 0,
        regressed: 0,
        unchanged: 0,
        changed: 0,
        unpaired: 0,
        not_comparable: 0,
      };
      block[cell.classification] += 1;
      counts.set(cell.scorerName, block);
    }
  }
  return counts;
}
