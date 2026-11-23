/**
 * The comparison as a file: exactly the cases the table shows, in its order, with every
 * run's values for each, and what the export covers (the runs and baseline, the search,
 * filters and sort, how cases were lined up, the counts, and each pair's paired numbers
 * over these cases). Scores are as each run recorded them. A change is the plain
 * difference from the baseline's value, or "from → to" for a label, alongside the
 * comparison's own classification; nothing is judged against a threshold.
 *
 * CSV holds the rows only, one per case, so it stays a plain table; JSON holds both.
 */
import type {
  Classification,
  ScorerCellComparison,
  ScorerDirection,
  ScorerValueType,
} from "@/lib/eval/comparison";
import type { EvalResultStatus } from "../types";
import { CELL_STATE_LABEL, cellDelta, isCompared, MISMATCH, scorerCellState } from "./cell-state";
import { casesText } from "./coverage";
import { describeFilter, type CaseAnalysis, type CaseFilter, type CaseSort } from "./filters";
import {
  comparePairs,
  exclusionOf,
  expectedKeyOf,
  type AlignmentMode,
  type CaseRow,
  type CompareModel,
  type Exclusion,
  type ExclusionReason,
  type PairComparison,
  type ScorerColumn,
} from "./model";
import { runLabeler, runTagger } from "./run-tags";

export interface ExportScore {
  scorer: string;
  /** As the run recorded it; null when it recorded none. */
  value: number | boolean | string | null;
  /** The difference from the baseline's value (true/false count as 1/0), or "from → to"
   *  for a label that changed; null for the baseline itself and for values not compared. */
  change: number | string | null;
  /** The comparison's classification of the cell; null for the baseline itself. */
  classification: Classification | null;
  /** Why the value wasn't compared with the baseline's, e.g. "Task error in baseline". */
  notCompared: string | null;
}

export interface ExportRunValues {
  runId: string;
  output: string | null;
  /** This run's own expected output for the case; null when it has none. */
  expected: string | null;
  status: EvalResultStatus | "no_result";
  latencyMs: number | null;
  cost: number | null;
  /** One per scorer, in `meta.scorers` order. */
  scores: ExportScore[];
}

export interface ExportRow {
  /** The table's case key: `id:<testCaseId>`, or `input:<canonical input>` across datasets. */
  case: string;
  /** From the baseline, or the first run (in table order) that has the case. */
  input: string;
  /** The expected output when every run that has the case expects the same one, as the
   *  table shows it once (`expectedKeyOf`); null when they differ, or expect none. Each
   *  run's own is in `runs`. */
  expected: string | null;
  /** One per run, in `meta.runs` order. */
  runs: ExportRunValues[];
}

interface PairedMeans {
  pairedCount: number;
  baselineMean: number | null;
  candidateMean: number | null;
  delta: number | null;
}

export interface ExportPair {
  baselineRunId: string;
  candidateRunId: string;
  candidateLabel: string;
  scorers: (PairedMeans & {
    name: string;
    /** Labels, and scorers with no direction, count changes instead of averaging. */
    transitions?: { changed: number; unchanged: number };
  })[];
  latencyMs: PairedMeans;
  cost: PairedMeans;
}

export interface ExportMeta {
  generatedAt: string;
  projectId: string;
  baseline: { runId: string; label: string };
  /** In table order: the baseline first, then oldest to newest. */
  runs: { id: string; label: string; evaluationName: string; datasetName: string | null }[];
  scorers: { name: string; valueType: ScorerValueType; direction: ScorerDirection }[];
  alignment: AlignmentMode;
  search: string;
  filters: (CaseFilter & { label: string })[];
  sort: CaseSort;
  counts: { matching: number; total: number; inAllRuns: number };
  /** Each candidate against the baseline, over the exported cases only. */
  pairs: ExportPair[];
  /** Runs whose results fall short of the cases they declared, so the export can't
   *  hold every case they ran. */
  truncatedRuns: { runId: string; label: string; loadedResults: number; declaredCases: number }[];
}

export interface ComparisonExport {
  meta: ExportMeta;
  rows: ExportRow[];
}

/** A difference without floating-point noise (0.95 − 0.4 is 0.55, not 0.5499999999999999). */
const difference = (n: number | null) => (n === null ? null : Number(n.toPrecision(12)));

const REASON_LABEL: Record<ExclusionReason, string> = {
  ...CELL_STATE_LABEL,
  version_mismatch: MISMATCH.version_mismatch.label,
  type_mismatch: MISMATCH.type_mismatch.label,
};

/** Why a candidate's cell wasn't compared, said from the candidate's own column. */
function notComparedText(
  { reason, runId }: Omit<Exclusion, "count">,
  candidateRunId: string,
  baselineRunId: string,
): string {
  const label = REASON_LABEL[reason];
  if (runId === candidateRunId) return label;
  if (runId === baselineRunId) return `${label} in baseline`;
  if (reason === "version_mismatch" || reason === "type_mismatch") return label;
  return reason === "not_scored" ? `${label} in either run` : `${label} in both runs`;
}

/** The change a cell shows: the numeric difference, or a label's transition. */
function changeOf(cell: ScorerCellComparison | undefined, column: ScorerColumn) {
  if (column.valueType !== "categorical") return difference(cellDelta(cell));
  const transition = isCompared(cell) ? cell?.transition : undefined;
  return transition && transition.from !== transition.to
    ? `${transition.from} → ${transition.to}`
    : null;
}

const pairMeans = (
  pairedCount: number,
  baselineMean: number | null,
  candidateMean: number | null,
  delta: number | null,
): PairedMeans => ({ pairedCount, baselineMean, candidateMean, delta: difference(delta) });

/** The comparison's `rows` (the table's cases, in its order) as an export. */
export function buildComparisonExport(
  model: CompareModel,
  {
    projectId,
    rows,
    analysis,
    generatedAt,
  }: {
    projectId: string;
    rows: readonly CaseRow[];
    analysis: CaseAnalysis;
    generatedAt: Date;
  },
): ComparisonExport {
  const { baselineRunId, runs, scorers } = model;
  const tagOf = runTagger(runs);
  const labelOf = runLabeler(runs, tagOf);
  // Over the exported cases only, so the paired numbers describe exactly these rows.
  const pairs = comparePairs(model, new Set(rows.map((r) => r.key)));

  const scoreOf = (row: CaseRow, runId: string, column: ScorerColumn): ExportScore => {
    const state = scorerCellState(row.byRun.get(runId), column.name);
    const value = state.kind === "value" ? state.value : null;
    if (runId === baselineRunId) {
      return { scorer: column.name, value, change: null, classification: null, notCompared: null };
    }
    const cell = pairs
      .get(runId)
      ?.byCase.get(row.key)
      ?.scorerCells.find((c) => c.scorerName === column.name);
    const base = row.byRun.get(baselineRunId);
    const why = exclusionOf(cell, column.name, base, row.byRun.get(runId), baselineRunId, runId);
    return {
      scorer: column.name,
      value,
      change: changeOf(cell, column),
      classification: cell?.classification ?? null,
      notCompared: why && notComparedText(why, runId, baselineRunId),
    };
  };

  const exportRow = (row: CaseRow): ExportRow => {
    const present = runs.flatMap((b) => row.byRun.get(b.run.id) ?? []);
    const agreed = new Set(present.map(expectedKeyOf)).size <= 1;
    return {
      case: row.key,
      input: present[0]?.input ?? "",
      expected: agreed ? (present[0]?.expectedOutput ?? null) : null,
      runs: runs.map(({ run }) => {
        const r = row.byRun.get(run.id);
        return {
          runId: run.id,
          output: r?.candidateOutput ?? null,
          expected: r?.expectedOutput ?? null,
          status: r?.status ?? "no_result",
          latencyMs: r?.durationMs ?? null,
          cost: r?.cost ?? null,
          scores: scorers.map((column) => scoreOf(row, run.id, column)),
        };
      }),
    };
  };

  const exportPair = ({ candidateRunId, comparison, cost }: PairComparison): ExportPair => ({
    baselineRunId,
    candidateRunId,
    candidateLabel: labelOf(candidateRunId),
    scorers: comparison.scorers.map((s) => ({
      name: s.name,
      ...pairMeans(s.pairedCount, s.baselineMean, s.candidateMean, s.delta),
      ...(s.transitions ? { transitions: s.transitions } : {}),
    })),
    latencyMs: pairMeans(
      comparison.duration.pairedCount,
      comparison.duration.baselineMeanMs,
      comparison.duration.candidateMeanMs,
      comparison.duration.deltaMs,
    ),
    cost: pairMeans(cost.pairedCount, cost.baselineMean, cost.candidateMean, cost.delta),
  });

  return {
    meta: {
      generatedAt: generatedAt.toISOString(),
      projectId,
      baseline: { runId: baselineRunId, label: labelOf(baselineRunId) },
      runs: runs.map(({ run }) => ({
        id: run.id,
        label: labelOf(run.id),
        evaluationName: run.evaluationName,
        datasetName: run.datasetName,
      })),
      scorers: scorers.map(({ name, valueType, direction }) => ({ name, valueType, direction })),
      alignment: model.alignment,
      search: analysis.q.trim(),
      filters: analysis.filters.map((f) => ({ ...f, label: describeFilter(f, tagOf) })),
      sort: analysis.sort,
      counts: {
        matching: rows.length,
        total: model.cases.length,
        inAllRuns: model.sharedByAllCount,
      },
      pairs: [...pairs.values()].map(exportPair),
      // The page's test for a run that fell short (`partialRunNotes`); the page also notes a
      // run with no results, which is listed here only when it declared cases.
      truncatedRuns: runs
        .filter(({ run, results }) => run.caseCount > results.length)
        .map(({ run, results }) => ({
          runId: run.id,
          label: labelOf(run.id),
          loadedResults: results.length,
          declaredCases: run.caseCount,
        })),
    },
    rows: rows.map(exportRow),
  };
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** One CSV field (RFC 4180): quoted when it holds a comma, quote or line break, with its
 *  quotes doubled. Text a spreadsheet would run as a formula gets a leading quote, unless
 *  it is just a number (a recorded "-3" stays "-3"). */
function csvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value !== "string") return String(value);
  const text = FORMULA_START.test(value) && !NUMBER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const SCORE_PARTS = ["value", "change", "classification", "not compared"] as const;

/** The rows as CSV: one header row, then one line per case. It starts with a byte order
 *  mark so spreadsheets read it as UTF-8. */
export function toCsv({ meta, rows }: ComparisonExport): string {
  const header = [
    "case",
    "input",
    "expected",
    ...meta.runs.flatMap(({ label }) => [
      `${label} · output`,
      `${label} · expected`,
      `${label} · status`,
      `${label} · latency ms`,
      `${label} · cost`,
      ...meta.scorers.flatMap(({ name }) =>
        SCORE_PARTS.map((part) => `${label} · ${name} · ${part}`),
      ),
    ]),
  ];
  const lines = rows.map((row) => [
    row.case,
    row.input,
    row.expected,
    ...row.runs.flatMap((r) => [
      r.output,
      r.expected,
      r.status,
      r.latencyMs,
      r.cost,
      ...r.scores.flatMap((s) => [s.value, s.change, s.classification, s.notCompared]),
    ]),
  ]);
  return `\uFEFF${[header, ...lines].map((line) => line.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export const toJson = (exp: ComparisonExport) => `${JSON.stringify(exp, null, 2)}\n`;

/** e.g. `comparison-1-baseline-v1-12-cases-20261111-1405.csv`, in the viewer's local time. */
export function exportFileName({ meta }: ComparisonExport, extension: "csv" | "json"): string {
  const at = new Date(meta.generatedAt);
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
  const time = `${two(at.getHours())}${two(at.getMinutes())}`;
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const parts = ["comparison", slug(meta.baseline.label), slug(casesText(meta.counts.matching))];
  return `${[...parts.filter(Boolean), `${date}-${time}`].join("-")}.${extension}`;
}
