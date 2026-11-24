/**
 * Which of a comparison's cases the table shows, and in what order: a search, filters
 * that pick cases by how a run changed or failed on them, and a sort.
 */
import type { Classification } from "@/lib/eval/comparison";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import type { ResultRow } from "../types";
import { scorerCellState, taskErrorOf } from "./cell-state";
import type { CaseRow, CompareModel, PairComparison, ScorerColumn } from "./model";

/** Cases a candidate improved, regressed or changed on against the baseline, cases with
 *  a task or scorer error, or cases some run has no result for. */
export type FilterKind = "improved" | "regressed" | "changed" | "errors" | "unmatched";

export const FILTER_KINDS: readonly FilterKind[] = [
  "regressed",
  "improved",
  "changed",
  "errors",
  "unmatched",
];

export interface CaseFilter {
  kind: FilterKind;
  /** A scorer's name, or null for any scorer (a scorer may be named anything, "any" too). */
  scorer: string | null;
  /** A run's id, or any run (any candidate, for improved, regressed and changed). Run ids
   *  are generated, so none is "any". */
  runId: string | "any";
}

export type CaseSort = { kind: "dataset" } | { kind: "regression"; scorer: string; runId: string };

/** The table's search, filters and sort. */
export interface CaseAnalysis {
  q: string;
  filters: CaseFilter[];
  sort: CaseSort;
}

export const FILTER_LABEL: Record<FilterKind, string> = {
  regressed: "Regressed",
  improved: "Improved",
  changed: "Changed",
  errors: "Errors",
  unmatched: "Unmatched",
};

export const DATASET_ORDER: CaseSort = { kind: "dataset" };

export const NO_ANALYSIS: CaseAnalysis = { q: "", filters: [], sort: DATASET_ORDER };

/** Whether the search or a filter narrows the cases (a sort only reorders them). */
export const isFiltering = ({ q, filters }: CaseAnalysis) => q.trim() !== "" || filters.length > 0;

export const isFilterKind = (text: string): text is FilterKind =>
  (FILTER_KINDS as readonly string[]).includes(text);

export const sameFilter = (a: CaseFilter, b: CaseFilter) =>
  a.kind === b.kind && a.scorer === b.scorer && a.runId === b.runId;

/** `filters` with `filter` added, unless it's already there. */
export const addFilter = (filters: CaseFilter[], filter: CaseFilter): CaseFilter[] =>
  filters.some((f) => sameFilter(f, filter)) ? filters : [...filters, filter];

/** The analysis with the search and every filter taken off; the sort stays, since it says
 *  how to read the cases, not which. */
export const clearSearchAndFilters = (analysis: CaseAnalysis): CaseAnalysis => ({
  ...analysis,
  q: "",
  filters: [],
});

/** What clearing takes off, for the button that does it. */
export function clearLabel({ q, filters }: CaseAnalysis): string {
  const searching = q.trim() !== "";
  if (searching && filters.length > 0) return "Clear search and filters";
  return searching ? "Clear search" : "Clear filters";
}

/** `filters` with `filter` taken off if it's there, else added. */
export const toggleFilter = (filters: CaseFilter[], filter: CaseFilter): CaseFilter[] =>
  filters.some((f) => sameFilter(f, filter))
    ? filters.filter((f) => !sameFilter(f, filter))
    : [...filters, filter];

const isAny = (runId: string) => runId === "any";

/** The comparison a change of runs or baseline leaves: its scorers, and each candidate's
 *  comparison with the new baseline. */
export interface NextComparison {
  scorers: readonly ScorerColumn[];
  pairs: ReadonlyMap<string, PairComparison>;
}

/** `analysis` without the filters and sort that pick nothing once `runIds` are compared
 *  against `baselineId`: a change against the baseline needs a candidate, and errors and
 *  unmatched need a run that is still compared. With `next`, a filter or sort on a scorer
 *  it doesn't have goes too, and so does improved, regressed or a regression sort where
 *  its pairs have no direction. The same object when nothing drops. */
export function pruneForRuns(
  analysis: CaseAnalysis,
  runIds: readonly string[],
  baselineId: string,
  next?: NextComparison | null,
): CaseAnalysis {
  const compared = new Set(runIds);
  const isCandidate = (runId: string) => compared.has(runId) && runId !== baselineId;
  const hasScorer = (scorer: string | null) =>
    !next || scorer === null || next.scorers.some((s) => s.name === scorer);
  const moves = (scorer: string | null, runId: string) =>
    !next || hasDirectionOn(next.scorers, next.pairs, scorer, runId);
  const filters = analysis.filters.filter(({ kind, scorer, runId }) => {
    if (kind === "errors" || kind === "unmatched") {
      return (isAny(runId) || compared.has(runId)) && hasScorer(scorer);
    }
    if (!isAny(runId) && !isCandidate(runId)) return false;
    return kind === "changed" ? hasScorer(scorer) : moves(scorer, runId);
  });
  const { sort } = analysis;
  const keptSort =
    sort.kind === "regression" && !(isCandidate(sort.runId) && moves(sort.scorer, sort.runId))
      ? DATASET_ORDER
      : sort;
  return filters.length === analysis.filters.length && keptSort === sort
    ? analysis
    : { ...analysis, filters, sort: keptSort };
}

/** A filter in words, e.g. "Regressed · quality · #2" or "Errors · any metric · any run". */
export function describeFilter(
  { kind, scorer, runId }: CaseFilter,
  tagOf: (runId: string) => string,
): string {
  const metric = kind === "unmatched" ? [] : [scorer ?? "any metric"];
  const run = isAny(runId) ? "any run" : tagOf(runId) || "a run not in this comparison";
  return [FILTER_LABEL[kind], ...metric, run].join(" · ");
}

// Decoding a long output isn't free and results are immutable query data, so each
// result's searchable text is worked out once, on the first search.
const searchTexts = new WeakMap<ResultRow, string[]>();
/** A result's input, output and expected output, lowercased, as stored and, when that
 *  differs, decoded as a value diff reads them (a structured value indented). */
function searchTextOf(r: ResultRow): string[] {
  let texts = searchTexts.get(r);
  if (texts === undefined) {
    texts = [];
    for (const stored of [r.input, r.candidateOutput, r.expectedOutput]) {
      if (!stored) continue;
      const shown = normalizeForDiff(stored);
      texts.push(stored.toLowerCase());
      if (shown !== stored) texts.push(shown.toLowerCase());
    }
    searchTexts.set(r, texts);
  }
  return texts;
}

/** Whether any run's input, output or expected output for the case contains the search,
 *  ignoring case, as stored or decoded; every case does for a blank search. */
export function matchesSearch(row: CaseRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [...row.byRun.values()].some((r) => searchTextOf(r).some((text) => text.includes(needle)));
}

// The pair's cell classifications each kind picks. Changed is any change from the
// baseline, so it takes in improved and regressed as well as a change with no direction.
const PICKS: Record<"improved" | "regressed" | "changed", ReadonlySet<Classification>> = {
  improved: new Set(["improved"]),
  regressed: new Set(["regressed"]),
  changed: new Set(["improved", "regressed", "changed"]),
};

/** A task error, or a scorer error on `scorer` (on any scorer for null), as the table's
 *  cells label them. */
function hasError(model: CompareModel, result: ResultRow, scorer: string | null): boolean {
  if (scorer === null) {
    return (
      taskErrorOf(result) !== null ||
      model.scorers.some((s) => scorerCellState(result, s.name).kind === "scorer_error")
    );
  }
  const { kind } = scorerCellState(result, scorer);
  return kind === "task_error" || kind === "scorer_error";
}

/** Whether `filter` picks the case. Improved, regressed and changed read the
 *  baseline–candidate pair's cell, so they never pick on the baseline itself; a run or
 *  scorer the comparison doesn't have picks nothing. */
export function matchesFilter(
  model: CompareModel,
  pairs: ReadonlyMap<string, PairComparison>,
  row: CaseRow,
  { kind, scorer, runId }: CaseFilter,
): boolean {
  if (kind === "errors" || kind === "unmatched") {
    return model.runs.some(({ run }) => {
      if (!isAny(runId) && run.id !== runId) return false;
      const result = row.byRun.get(run.id);
      return kind === "unmatched" ? !result : !!result && hasError(model, result, scorer);
    });
  }
  const picks = PICKS[kind];
  const candidates = isAny(runId) ? [...pairs.values()] : [pairs.get(runId)];
  return candidates.some(
    (pair) =>
      pair?.byCase
        .get(row.key)
        ?.scorerCells.some(
          (cell) =>
            (scorer === null || cell.scorerName === scorer) && picks.has(cell.classification),
        ) ?? false,
  );
}

/** Whether a case can improve or regress on `column` in `runId`'s pair with the baseline,
 *  or in some pair for any run: only a change with a direction can, and only it sorts by
 *  regression. Each pair reads the scorer as it compared it, which can differ from the
 *  column when another run recorded another kind of value; with no pair to read, the
 *  column says. */
export function hasDirection(
  column: ScorerColumn,
  pairs: ReadonlyMap<string, PairComparison>,
  runId: string | "any",
): boolean {
  const directed = (p: Pick<ScorerColumn, "valueType" | "direction">) =>
    p.valueType !== "categorical" && p.direction !== "none";
  const read = isAny(runId) ? [...pairs.values()] : [pairs.get(runId)];
  const compared = read.flatMap(
    (pair) => pair?.comparison.scorers.filter((s) => s.name === column.name) ?? [],
  );
  if (compared.length === 0) return directed(column);
  // A pair's totals take their kind of value from the first case it compared, so a scorer
  // that recorded labels there can still have later cases that moved with a direction: the
  // ones the comparison gave a change.
  return (
    compared.some(directed) ||
    read.some((pair) =>
      [...(pair?.byCase.values() ?? [])].some((c) =>
        c.scorerCells.some((cell) => cell.scorerName === column.name && cell.delta !== null),
      ),
    )
  );
}

/** Whether improved or regressed can pick a case on `scorer` (on any of `columns` for
 *  null) in `runId`'s pair with the baseline, or in some pair for any run. */
export function hasDirectionOn(
  columns: readonly ScorerColumn[],
  pairs: ReadonlyMap<string, PairComparison>,
  scorer: string | null,
  runId: string | "any",
): boolean {
  return columns.some(
    (column) => (scorer === null || column.name === scorer) && hasDirection(column, pairs, runId),
  );
}

/** How far the candidate fell behind the baseline on the case: the pair's change for the
 *  scorer, signed so that worse is positive; null when the pair didn't compare it. */
function regressionSize(
  pairs: ReadonlyMap<string, PairComparison>,
  row: CaseRow,
  { scorer, runId }: { scorer: string; runId: string },
): number | null {
  const cell = pairs
    .get(runId)
    ?.byCase.get(row.key)
    ?.scorerCells.find((c) => c.scorerName === scorer);
  // The comparison sets a delta only on a compared number with a direction.
  if (cell?.delta == null) return null;
  if (cell.direction === "higher_is_better") return -cell.delta;
  return cell.direction === "lower_is_better" ? cell.delta : null;
}

function sortCases(
  pairs: ReadonlyMap<string, PairComparison>,
  rows: CaseRow[],
  sort: CaseSort,
): CaseRow[] {
  if (sort.kind === "dataset") return rows;
  const size = new Map(rows.map((row) => [row, regressionSize(pairs, row, sort)]));
  // Worst first; the sort is stable, so ties keep dataset order, and cases the pair
  // didn't compare go last.
  return [...rows].sort((a, b) => {
    const x = size.get(a) ?? null;
    const y = size.get(b) ?? null;
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    return y - x;
  });
}

/** The cases the search and every filter pick, in the sort's order (dataset order by
 *  default). They are the comparison's own rows, so each keeps every run's values. */
export function selectCases(
  model: CompareModel,
  pairs: ReadonlyMap<string, PairComparison>,
  { q, filters, sort }: CaseAnalysis,
): CaseRow[] {
  const picked = model.cases.filter(
    (row) => matchesSearch(row, q) && filters.every((f) => matchesFilter(model, pairs, row, f)),
  );
  return sortCases(pairs, picked, sort);
}
