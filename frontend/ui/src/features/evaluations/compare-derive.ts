/**
 * Pure presentation-derivation for the comparison page. Everything here is derived
 * transparently from the backend comparison output (RunComparison / CompareResultRow) —
 * no comparison MATH is done here (that stays in `lib/eval/comparison.ts`). This module
 * only turns those numbers into a verdict, a filter/sort order, and label helpers, so
 * the view stays thin and this logic is unit-testable.
 */
import type { CompareResultRow, RunComparison, Classification } from "./types";

// Reasons that make deltas untrustworthy → "Not comparable". `different_evaluation`
// alone is cross-evaluation (allowed + labeled), not an incompatibility.
export const BLOCKING_REASONS = new Set([
  "different_dataset_version",
  "baseline_not_terminal",
  "baseline_missing",
  "no_baseline",
  "main_scorer_incompatible",
]);

export const REASON_LABEL: Record<string, string> = {
  no_baseline: "No baseline was chosen.",
  baseline_missing: "The baseline run wasn't found.",
  different_evaluation: "The runs are from different evaluations.",
  different_dataset_version:
    "The runs used different immutable dataset versions, so their cases don't line up.",
  baseline_not_terminal: "The baseline run hasn't finished.",
  main_scorer_incompatible:
    "The main scorer's name/version differs, so there's no comparable pair.",
};

export type Verdict =
  | "improvement"
  | "regression"
  | "tradeoff"
  | "tie"
  | "not_comparable"
  | "pending";

export const VERDICT_META: Record<
  Verdict,
  { label: string; tone: "good" | "bad" | "warn" | "neutral" }
> = {
  improvement: { label: "Improvement", tone: "good" },
  regression: { label: "Regression", tone: "bad" },
  tradeoff: { label: "Tradeoff", tone: "warn" },
  tie: { label: "Tie", tone: "neutral" },
  not_comparable: { label: "Not comparable", tone: "neutral" },
  pending: { label: "Comparison pending", tone: "neutral" },
};

const TERMINAL = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "incomplete",
  "cancelled",
]);

/**
 * Transparent, backend-sourced verdict. `opsWorsened` is a UI-computed hint (duration
 * or cost went up) that promotes a quality improvement to a Tradeoff; when it's not
 * yet known the verdict is main-scorer-only and operational changes are listed apart.
 */
export function deriveVerdict(
  comparison: RunComparison,
  candidateStatus: string,
  baselineStatus: string,
  opsWorsened?: boolean,
): { verdict: Verdict; reasons: string[] } {
  const blocking = comparison.reasons.filter((r) => BLOCKING_REASONS.has(r));
  if (!comparison.available || blocking.length > 0) {
    const rs = blocking.length > 0 ? blocking : (["no_baseline"] as const);
    return { verdict: "not_comparable", reasons: rs.map((r) => REASON_LABEL[r] ?? r) };
  }
  if (!TERMINAL.has(candidateStatus) || !TERMINAL.has(baselineStatus)) {
    return {
      verdict: "pending",
      reasons: ["A run hasn't finished, so the comparison isn't final."],
    };
  }

  const cases = comparison.caseCounts;
  const cells = comparison.scoreCellCounts;
  const mainDelta = comparison.mainScore.delta;
  const reasons: string[] = [];

  // Main-scorer direction, taken from the per-case classifications — which the engine
  // already computed WITH each scorer's direction, so a lower-is-better main scorer
  // reads a score DECREASE as an improvement. Deriving direction from the raw mainDelta
  // sign (as before) mislabeled every lower-is-better run's improvements as regressions.
  // (mainDelta is still used below for the human-readable magnitude, not the verdict.)
  let mainVerdict: "up" | "down" | "flat";
  if (cases.regressed > 0 && cases.improved === 0) mainVerdict = "down";
  else if (cases.improved > 0 && cases.regressed === 0) mainVerdict = "up";
  else mainVerdict = "flat"; // none changed, or mixed → decided below

  const casesPaired = cases.improved + cases.regressed + cases.unchanged + cases.changed;
  if (mainDelta !== null) {
    const mag = `${Math.abs(mainDelta * 100).toFixed(1)} pp`;
    reasons.push(
      mainDelta < 0
        ? `Main score decreased by ${mag}.`
        : mainDelta > 0
          ? `Main score increased by ${mag}.`
          : "Main score was unchanged.",
    );
  }
  if (cases.regressed > 0)
    reasons.push(
      `${cases.regressed} of ${casesPaired} test case${casesPaired === 1 ? "" : "s"} regressed on the main scorer.`,
    );
  if (cases.improved > 0) reasons.push(`${cases.improved} improved.`);
  if (cells.regressed > 0)
    reasons.push(`${cells.regressed} scorer value${cells.regressed === 1 ? "" : "s"} regressed.`);

  let verdict: Verdict;
  if (mainVerdict === "down") verdict = "regression";
  else if (mainVerdict === "up") {
    // Quality up, but a secondary scorer regressed or ops worsened → tradeoff.
    verdict = cells.regressed > 0 || opsWorsened ? "tradeoff" : "improvement";
  } else {
    // Main flat. A secondary regression is a tradeoff; a truly-flat run is a tie.
    if (cells.regressed > 0 && cells.improved > 0) verdict = "tradeoff";
    else if (cells.regressed > 0) verdict = "regression";
    else if (cases.improved > 0 && cases.regressed > 0) verdict = "tradeoff";
    else if (cells.improved > 0) verdict = "improvement";
    else verdict = "tie";
  }
  if (verdict === "tradeoff" && opsWorsened && cells.regressed === 0)
    reasons.push("Quality held or improved, but duration/cost increased.");
  if (verdict === "tie") reasons.push("No change on the main scorer or any scorer cell.");
  return { verdict, reasons };
}

// ── Case filters + ordering ───────────────────────────────────────────────

export type CaseFilterId =
  | "all"
  | "regressions"
  | "improvements"
  | "errors"
  | "changed_outputs"
  | "unpaired";

export function caseHasError(r: CompareResultRow): boolean {
  return (
    !!r.candidateTaskError ||
    !!r.baselineTaskError ||
    r.candidateScores.some((s) => s.error) ||
    r.baselineScores.some((s) => s.error)
  );
}

export const CASE_FILTERS: Array<{ id: CaseFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "improvements", label: "Improvements" },
  { id: "errors", label: "Errors" },
  { id: "changed_outputs", label: "Changed outputs" },
  { id: "unpaired", label: "Unpaired" },
];

export function matchesFilter(r: CompareResultRow, f: CaseFilterId): boolean {
  const change = r.comparison?.caseChange ?? null;
  switch (f) {
    case "all":
      return true;
    case "regressions":
      return change === "regressed" || (r.comparison?.regressedCellCount ?? 0) > 0;
    case "improvements":
      return change === "improved";
    case "errors":
      return caseHasError(r);
    case "changed_outputs":
      return r.outputChanged === true;
    case "unpaired":
      return r.comparison?.pairing !== "paired" || change === "not_comparable";
  }
}

export function filterCounts(rows: CompareResultRow[]): Record<CaseFilterId, number> {
  const out = {} as Record<CaseFilterId, number>;
  for (const f of CASE_FILTERS) out[f.id] = rows.filter((r) => matchesFilter(r, f.id)).length;
  return out;
}

export type CaseSortId =
  | "default"
  | "worst_regression"
  | "most_scorer_regressions"
  | "duration_increase"
  | "cost_increase"
  | "dataset";

/** Default priority: task errors → main regressions → other scorer regressions →
 *  improvements → changed-but-neutral → unchanged. Lower rank sorts first. */
function defaultRank(r: CompareResultRow): number {
  if (r.candidateTaskError || r.baselineTaskError) return 0;
  const change = r.comparison?.caseChange ?? null;
  if (change === "regressed") return 1;
  if ((r.comparison?.regressedCellCount ?? 0) > 0) return 2;
  if (change === "improved") return 3;
  if (r.outputChanged === true || change === "changed") return 4;
  if (change === "unpaired" || change === "not_comparable") return 6;
  return 5; // unchanged
}

export function sortCases(rows: CompareResultRow[], sort: CaseSortId): CompareResultRow[] {
  const withIndex = rows.map((r, i) => ({ r, i }));
  const cmp: Record<
    CaseSortId,
    (a: { r: CompareResultRow; i: number }, b: { r: CompareResultRow; i: number }) => number
  > = {
    default: (a, b) => defaultRank(a.r) - defaultRank(b.r) || a.i - b.i,
    worst_regression: (a, b) =>
      (a.r.comparison?.mainScore.delta ?? 0) - (b.r.comparison?.mainScore.delta ?? 0),
    most_scorer_regressions: (a, b) =>
      (b.r.comparison?.regressedCellCount ?? 0) - (a.r.comparison?.regressedCellCount ?? 0),
    duration_increase: (a, b) =>
      (b.r.comparison?.durationDeltaMs ?? -Infinity) -
      (a.r.comparison?.durationDeltaMs ?? -Infinity),
    cost_increase: (a, b) => costDelta(b.r) - costDelta(a.r),
    dataset: (a, b) => a.i - b.i,
  };
  return [...withIndex].sort(cmp[sort]).map((x) => x.r);
}

function costDelta(r: CompareResultRow): number {
  if (r.candidateCost === null || r.baselineCost === null) return -Infinity;
  return r.candidateCost - r.baselineCost;
}

export const CASE_SORTS: Array<{ id: CaseSortId; label: string }> = [
  { id: "default", label: "Most impactful" },
  { id: "worst_regression", label: "Worst main regression" },
  { id: "most_scorer_regressions", label: "Most scorer regressions" },
  { id: "duration_increase", label: "Duration increase" },
  { id: "cost_increase", label: "Cost increase" },
  { id: "dataset", label: "Dataset order" },
];

// ── Case-level status (distinct task vs scorer error) ─────────────────────

export type CaseStatus = Classification | "task_error" | "scorer_error" | "pending";

export function caseStatus(r: CompareResultRow): CaseStatus {
  if (r.candidateTaskError || r.baselineTaskError) return "task_error";
  const change = r.comparison?.caseChange ?? null;
  if (change === "not_comparable" && caseHasError(r)) return "scorer_error";
  if (r.candidateStatus === null || r.baselineStatus === null) return "unpaired";
  return change ?? "unchanged";
}
