/**
 * Candidate-vs-baseline comparison engine — the single source of truth.
 *
 * Pure, deterministic, and free of Prisma/HTTP: it takes DB-shaped inputs (a
 * candidate run + its results/scores, and the baseline run + its results/scores)
 * and derives the comparison the run-detail and run-list read paths return. See
 * `docs/offline-eval-comparison-contract.md` for the product semantics.
 *
 * The backend owns comparison: the SDK reports raw scores and a `baseline_run_id`
 * only. Stored `EvaluationResult.change` / `baselineOutput` are NOT consulted here —
 * everything is derived from the two runs' raw results and scores.
 */

// ── Vocabularies ────────────────────────────────────────────────────────

export type ScorerValueType = "numeric" | "boolean" | "categorical";
export type ScorerDirection = "higher_is_better" | "lower_is_better" | "none";

/**
 * A cell/case verdict. `changed` is the non-directional categorical transition
 * (baseline → candidate differ) — distinct from improved/regressed, which require a
 * direction. `unpaired` = present on one side only; `not_comparable` = paired but
 * un-trustable (version mismatch, missing value, error).
 */
export type Classification =
  | "improved"
  | "regressed"
  | "unchanged"
  | "changed"
  | "unpaired"
  | "not_comparable";

/** Why a cell could not be directionally compared. */
export type CellReason =
  | "candidate_missing"
  | "baseline_missing"
  | "candidate_error"
  | "baseline_error"
  | "not_scored"
  | "version_mismatch"
  | "type_mismatch";

/** Why a run comparison is unavailable or untrustworthy. */
export type RunComparabilityReason =
  | "no_baseline"
  | "baseline_missing"
  | "different_evaluation"
  | "different_dataset_version"
  | "baseline_not_terminal"
  | "candidate_not_terminal"
  | "case_set_mismatch";

/**
 * The four-state comparison discriminant, derived from `available`/`trustworthy`/
 * `reasons` so a client never has to re-classify the reason vocabulary itself:
 *  - `trustworthy`: paired, same evaluation, both terminal — an authoritative verdict.
 *  - `exploratory`: computed but NON-authoritative (different evaluation / dataset
 *    version, or a mismatched case set). Shown for exploration, never as an ordinary verdict.
 *  - `pending`: a run is still running or was stopped early (not terminal).
 *  - `unavailable`: there is no baseline to compare against.
 */
export type ComparisonState = "trustworthy" | "exploratory" | "pending" | "unavailable";

const PENDING_REASONS: ReadonlySet<RunComparabilityReason> = new Set([
  "candidate_not_terminal",
  "baseline_not_terminal",
]);

/** Collapse available/trustworthy/reasons into the single non-overlapping state. */
export function deriveComparisonState(
  available: boolean,
  trustworthy: boolean,
  reasons: readonly RunComparabilityReason[],
): ComparisonState {
  if (!available) return "unavailable";
  if (trustworthy) return "trustworthy";
  // A non-terminal run is pending until it settles — even if it would also be
  // incompatible once complete, "still running" is the more actionable state.
  if (reasons.some((r) => PENDING_REASONS.has(r))) return "pending";
  return "exploratory";
}

// ── Inputs (DB-shaped, decoupled from Prisma) ───────────────────────────

export interface ComparisonScorerMeta {
  name: string;
  version: string;
  /** Optional richer metadata (a future SDK may send it); absence → inferred/defaulted. */
  valueType?: ScorerValueType | null;
  direction?: ScorerDirection | null;
  threshold?: number | null;
}

export interface ComparisonScore {
  scorerName: string;
  scorerVersion: string;
  numericValue: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  error: string | null;
}

export interface ComparisonResult {
  testCaseId: string;
  status: string; // passed | failed | errored | not_scored
  candidateOutput: string | null;
  durationMs: number | null;
  scores: ComparisonScore[];
}

export interface ComparisonRun {
  id: string;
  runNumber: number;
  evaluationId: string;
  datasetVersionId: string;
  candidateVersion: string;
  status: string; // running | completed | completed_with_errors | failed | incomplete | cancelled
  baselineRunId: string | null;
  /** Declared scorers (`[{name, version}]` from the run, optionally enriched). */
  scorers: ComparisonScorerMeta[];
}

export interface CompareRunsInput {
  candidate: ComparisonRun;
  candidateResults: ComparisonResult[];
  /** null when no baseline is configured OR the referenced baseline run was not found. */
  baseline: ComparisonRun | null;
  baselineResults: ComparisonResult[];
}

// ── Outputs ─────────────────────────────────────────────────────────────

/** Count block. `changed` is 0 for directional (numeric/boolean) scorers. */
export interface CountBlock {
  improved: number;
  regressed: number;
  unchanged: number;
  changed: number;
  unpaired: number;
  not_comparable: number;
}

export interface ScorerAggregate {
  name: string;
  version: string;
  valueType: ScorerValueType;
  direction: ScorerDirection;
  /** Means over paired, successfully-scored cells only (null for categorical). */
  candidateMean: number | null;
  baselineMean: number | null;
  delta: number | null;
  /** How many paired cells were included in the means (the denominator). */
  pairedCount: number;
  /** Categorical only: transition tallies over paired, successfully-scored cells. */
  transitions?: { changed: number; unchanged: number };
}

export interface ScorerCellComparison {
  scorerName: string;
  scorerVersion: string;
  valueType: ScorerValueType | null;
  direction: ScorerDirection | null;
  candidateValue: number | boolean | string | null;
  baselineValue: number | boolean | string | null;
  /** Numeric only; null otherwise. */
  delta: number | null;
  /** Categorical only. */
  transition?: { from: string | null; to: string | null };
  classification: Classification;
  reason?: CellReason;
}

export interface ResultComparison {
  testCaseId: string;
  status: string;
  candidateOutput: string | null;
  /** Derived from the baseline result (never the stored candidate column). */
  baselineOutput: string | null;
  pairing: "paired" | "candidate_only" | "baseline_only";
  /** SDK-measured candidate case duration (task + scorers); null → Unknown, never 0. */
  durationMs: number | null;
  /** The baseline case's duration, from the baseline result; null → Unknown. */
  baselineDurationMs: number | null;
  /** candidate − baseline case duration; null unless both are known. */
  durationDeltaMs: number | null;
  scorerCells: ScorerCellComparison[];
  /** Convenience for the "regressed on N of M scorer cells" secondary label. */
  regressedCellCount: number;
  comparableCellCount: number;
}

export interface RunComparison {
  available: boolean;
  trustworthy: boolean;
  /**
   * Four-state discriminant derived from available/trustworthy/reasons. Clients
   * should switch on this rather than re-deriving intent from `reasons`; in
   * particular `exploratory` and `pending` are otherwise wire-identical
   * (available:true, trustworthy:false).
   */
  state: ComparisonState;
  reasons: RunComparabilityReason[];
  baseline: { runId: string; runNumber: number; candidateVersion: string } | null;
  scoreCellCounts: CountBlock;
  scorers: ScorerAggregate[];
  /**
   * Aggregate CASE-duration statistics over paired cases where both sides reported a
   * duration. This is a mean of per-case wall-clock (task + scorers), explicitly NOT
   * the run's wall-clock elapsed time — concurrent cases are not summed here.
   */
  duration: {
    candidateMeanMs: number | null;
    baselineMeanMs: number | null;
    deltaMs: number | null;
    pairedCount: number;
  };
}

export interface CompareRunsOutput {
  comparison: RunComparison;
  results: ResultComparison[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Deliberately excludes "incomplete" and "cancelled": those statuses mean the run
// stopped before scoring every case it was going to, so a run in either state must
// never pass the comparability check as if it were a full, trustworthy result set.
const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed"]);

function emptyCounts(): CountBlock {
  return { improved: 0, regressed: 0, unchanged: 0, changed: 0, unpaired: 0, not_comparable: 0 };
}

type TypedValue =
  | { kind: "value"; valueType: ScorerValueType; value: number | boolean | string }
  | { kind: "error" }
  | { kind: "missing" };

/** Resolve one score row into a typed value / error / missing. */
function readScore(score: ComparisonScore | undefined | null): TypedValue {
  if (!score) return { kind: "missing" };
  if (score.error !== null && score.error !== undefined) return { kind: "error" };
  if (score.boolValue !== null && score.boolValue !== undefined) {
    return { kind: "value", valueType: "boolean", value: score.boolValue };
  }
  if (score.numericValue !== null && score.numericValue !== undefined) {
    return { kind: "value", valueType: "numeric", value: score.numericValue };
  }
  if (score.stringValue !== null && score.stringValue !== undefined) {
    return { kind: "value", valueType: "categorical", value: score.stringValue };
  }
  return { kind: "missing" }; // present row, no value and no error → nothing to compare
}

/** Default direction when the SDK didn't declare one. */
function defaultDirection(valueType: ScorerValueType): ScorerDirection {
  return valueType === "categorical" ? "none" : "higher_is_better";
}

function resolveMeta(
  scorerName: string,
  metaByName: Map<string, ComparisonScorerMeta>,
  valueType: ScorerValueType,
): { valueType: ScorerValueType; direction: ScorerDirection } {
  const meta = metaByName.get(scorerName);
  const vt = meta?.valueType ?? valueType;
  const direction = meta?.direction ?? defaultDirection(vt);
  return { valueType: vt, direction };
}

/** Directional numeric/boolean verdict. */
function directionalVerdict(
  candidate: number,
  baseline: number,
  direction: ScorerDirection,
): Classification {
  if (candidate === baseline) return "unchanged";
  if (direction === "none") return "changed";
  const higher = candidate > baseline;
  const better = direction === "higher_is_better" ? higher : !higher;
  return better ? "improved" : "regressed";
}

// ── The engine ──────────────────────────────────────────────────────────

export function compareRuns(input: CompareRunsInput): CompareRunsOutput {
  const { candidate, candidateResults, baseline, baselineResults } = input;

  // Availability + trust.
  const reasons: RunComparabilityReason[] = [];
  const available = baseline !== null;
  if (!available) {
    reasons.push(candidate.baselineRunId ? "baseline_missing" : "no_baseline");
  } else {
    if (baseline.evaluationId !== candidate.evaluationId) reasons.push("different_evaluation");
    if (baseline.datasetVersionId !== candidate.datasetVersionId) {
      reasons.push("different_dataset_version");
    }
    if (!TERMINAL_STATUSES.has(baseline.status)) reasons.push("baseline_not_terminal");
    // The candidate can be watched live (`running`) or stopped early — either way its
    // own numbers aren't final, so it's just as disqualifying as a non-terminal baseline.
    if (!TERMINAL_STATUSES.has(candidate.status)) reasons.push("candidate_not_terminal");
  }

  // Per-metric metadata keyed on the EMITTED-METRIC name (what a Score row reports), so a
  // definition whose name differs from its metric still resolves. Metric-first: there is no
  // single "main" metric, so every scorer is compared on equal footing.
  const metaByName = new Map<string, ComparisonScorerMeta>();
  for (const s of [...(baseline?.scorers ?? []), ...candidate.scorers]) {
    metaByName.set(s.name, s); // candidate last → candidate wins
  }

  // Index baseline results + scores by test-case and scorer name.
  const baselineByCase = new Map<string, ComparisonResult>();
  for (const r of baselineResults) baselineByCase.set(r.testCaseId, r);
  const candidateByCase = new Map<string, ComparisonResult>();
  for (const r of candidateResults) candidateByCase.set(r.testCaseId, r);

  const scoreCellCounts = emptyCounts();
  const results: ResultComparison[] = [];
  // Cases scored on one side only — drives the `case_set_mismatch` comparability reason.
  let unpairedCases = 0;

  // Per-scorer aggregate accumulators over paired, successfully-scored cells.
  interface Agg {
    valueType: ScorerValueType;
    direction: ScorerDirection;
    candSum: number;
    baseSum: number;
    n: number;
    changed: number;
    unchanged: number;
  }
  const aggByScorer = new Map<string, Agg>();
  let durCandSum = 0;
  let durBaseSum = 0;
  let durPairs = 0;

  const scoreByName = (r: ComparisonResult | undefined) => {
    const m = new Map<string, ComparisonScore>();
    if (r) {
      for (const s of r.scores) {
        // A result can legitimately carry more than one row for the same scorer name
        // (a scorer version bump, or a delayed re-score) — pick a winner that doesn't
        // depend on the order the caller's rows arrived in (that order is undefined
        // for a bare Prisma `include`, and differs between callers), so the same data
        // classifies the same way everywhere. Highest scorerVersion wins.
        const existing = m.get(s.scorerName);
        if (!existing || s.scorerVersion > existing.scorerVersion) m.set(s.scorerName, s);
      }
    }
    return m;
  };

  // Iterate the union of test-case ids so an unpaired case on either side is counted.
  const allCaseIds = new Set<string>([
    ...candidateResults.map((r) => r.testCaseId),
    ...(available ? baselineResults.map((r) => r.testCaseId) : []),
  ]);

  for (const testCaseId of allCaseIds) {
    const cand = candidateByCase.get(testCaseId);
    const base = available ? baselineByCase.get(testCaseId) : undefined;
    const pairing: ResultComparison["pairing"] = cand
      ? base
        ? "paired"
        : "candidate_only"
      : "baseline_only";

    const candScores = scoreByName(cand);
    const baseScores = scoreByName(base);
    const scorerNames = new Set<string>([...candScores.keys(), ...baseScores.keys()]);

    const scorerCells: ScorerCellComparison[] = [];
    for (const scorerName of scorerNames) {
      const cs = candScores.get(scorerName);
      const bs = baseScores.get(scorerName);
      const candV = readScore(cs);
      const baseV = readScore(bs);
      const vtGuess: ScorerValueType =
        (candV.kind === "value" && candV.valueType) ||
        (baseV.kind === "value" && baseV.valueType) ||
        "numeric";
      const { valueType, direction } = resolveMeta(scorerName, metaByName, vtGuess);

      const cell: ScorerCellComparison = {
        scorerName,
        scorerVersion: cs?.scorerVersion ?? bs?.scorerVersion ?? "",
        valueType: candV.kind === "value" || baseV.kind === "value" ? valueType : null,
        direction: candV.kind === "value" || baseV.kind === "value" ? direction : null,
        candidateValue: candV.kind === "value" ? candV.value : null,
        baselineValue: baseV.kind === "value" ? baseV.value : null,
        delta: null,
        classification: "not_comparable",
      };

      if (pairing !== "paired") {
        // The case itself doesn't exist on both sides.
        cell.classification = "unpaired";
        cell.reason = !cand ? "candidate_missing" : "baseline_missing";
      } else if (candV.kind === "missing" || baseV.kind === "missing") {
        // The case ran on both sides, but this scorer produced no value on one of
        // them — un-trustable, not "not in both runs" (that's what `unpaired` means).
        cell.classification = "not_comparable";
        cell.reason = candV.kind === "missing" ? "candidate_missing" : "baseline_missing";
      } else if (candV.kind === "error" || baseV.kind === "error") {
        cell.classification = "not_comparable";
        cell.reason = candV.kind === "error" ? "candidate_error" : "baseline_error";
      } else if (cs && bs && cs.scorerVersion !== bs.scorerVersion) {
        // Never compare across scorer versions — the measuring instrument changed.
        cell.classification = "not_comparable";
        cell.reason = "version_mismatch";
      } else if (candV.valueType !== baseV.valueType) {
        // The two sides hold different kinds of value for the same scorer (e.g. a
        // numeric candidate value against a categorical baseline value) — the same
        // "the measuring instrument changed" case the version guard exists for, just
        // reached without a version bump.
        cell.classification = "not_comparable";
        cell.reason = "type_mismatch";
      } else {
        // Both sides have a value of the same OBSERVED kind, versions match → typed
        // comparison. Dispatch on the observed kind, never declared metadata, so a
        // scorer whose declaration disagrees with what it actually stored (e.g. a
        // scorer declared "boolean" that actually stores 0.3) can't be coerced into
        // the wrong arithmetic. Declared metadata still drives `direction` — that
        // can't be observed from the data.
        const observedValueType = candV.valueType;
        let comparable = true;
        if (observedValueType === "categorical" || direction === "none") {
          const c = String(candV.value);
          const b = String(baseV.value);
          cell.transition = { from: b, to: c };
          cell.classification = c === b ? "unchanged" : "changed";
        } else if (observedValueType === "boolean") {
          const c = candV.value ? 1 : 0;
          const b = baseV.value ? 1 : 0;
          cell.delta = c - b;
          cell.classification = directionalVerdict(c, b, direction);
        } else {
          const c = candV.value as number;
          const b = baseV.value as number;
          if (Number.isFinite(c) && Number.isFinite(b)) {
            cell.delta = c - b;
            cell.classification = directionalVerdict(c, b, direction);
          } else {
            // A non-finite stored value can never yield a directional verdict or
            // poison a mean.
            comparable = false;
            cell.classification = "not_comparable";
            cell.reason = "not_scored";
          }
        }

        if (comparable) {
          // Accumulate the per-scorer aggregate (paired, successfully-scored only).
          const agg =
            aggByScorer.get(scorerName) ??
            ({
              valueType: observedValueType,
              direction,
              candSum: 0,
              baseSum: 0,
              n: 0,
              changed: 0,
              unchanged: 0,
            } as Agg);
          if (observedValueType === "categorical" || direction === "none") {
            if (cell.classification === "changed") agg.changed += 1;
            else agg.unchanged += 1;
          } else {
            agg.candSum +=
              observedValueType === "boolean" ? (candV.value ? 1 : 0) : (candV.value as number);
            agg.baseSum +=
              observedValueType === "boolean" ? (baseV.value ? 1 : 0) : (baseV.value as number);
          }
          agg.n += 1;
          aggByScorer.set(scorerName, agg);
        }
      }

      scorerCells.push(cell);
      scoreCellCounts[cell.classification] += 1;
    }

    if (pairing !== "paired") unpairedCases += 1;

    // Case-duration comparison (paired, both known) — never sum, never zero-fill.
    const baselineDurationMs = base?.durationMs ?? null;
    const durationDeltaMs =
      cand?.durationMs != null && base?.durationMs != null
        ? cand.durationMs - base.durationMs
        : null;
    if (pairing === "paired" && cand?.durationMs != null && base?.durationMs != null) {
      durCandSum += cand.durationMs;
      durBaseSum += base.durationMs;
      durPairs += 1;
    }

    const regressedCellCount = scorerCells.filter((c) => c.classification === "regressed").length;
    const comparableCellCount = scorerCells.filter(
      (c) =>
        c.classification === "improved" ||
        c.classification === "regressed" ||
        c.classification === "unchanged" ||
        c.classification === "changed",
    ).length;

    results.push({
      testCaseId,
      status: cand?.status ?? base?.status ?? "not_scored",
      candidateOutput: cand?.candidateOutput ?? null,
      baselineOutput: base?.candidateOutput ?? null, // the baseline run's output for this case
      pairing,
      durationMs: cand?.durationMs ?? null,
      baselineDurationMs,
      durationDeltaMs,
      scorerCells,
      regressedCellCount,
      comparableCellCount,
    });
  }

  // case_set_mismatch: the two runs didn't score the same set of cases (a subset run,
  // a `--filter`, a retried run, a partially-ingested candidate) — the aggregate numbers
  // are then over different denominators and can't be presented as authoritative.
  if (available && unpairedCases > 0) reasons.push("case_set_mismatch");

  const trustworthy = available && reasons.length === 0;

  // Per-scorer aggregate projection (declared scorers first, then any others seen).
  const scorerOrder: string[] = [];
  const seen = new Set<string>();
  for (const s of candidate.scorers) {
    if (!seen.has(s.name)) {
      scorerOrder.push(s.name);
      seen.add(s.name);
    }
  }
  for (const name of aggByScorer.keys()) {
    if (!seen.has(name)) {
      scorerOrder.push(name);
      seen.add(name);
    }
  }

  const scorers: ScorerAggregate[] = scorerOrder.map((name) => {
    const agg = aggByScorer.get(name);
    const meta = metaByName.get(name);
    const valueType = agg?.valueType ?? meta?.valueType ?? "numeric";
    const direction = agg?.direction ?? meta?.direction ?? defaultDirection(valueType);
    const version = meta?.version ?? "";
    if (!agg || agg.n === 0) {
      return {
        name,
        version,
        valueType,
        direction,
        candidateMean: null,
        baselineMean: null,
        delta: null,
        pairedCount: 0,
        ...(valueType === "categorical" || direction === "none"
          ? { transitions: { changed: 0, unchanged: 0 } }
          : {}),
      };
    }
    if (valueType === "categorical" || direction === "none") {
      return {
        name,
        version,
        valueType,
        direction,
        candidateMean: null,
        baselineMean: null,
        delta: null,
        pairedCount: agg.n,
        transitions: { changed: agg.changed, unchanged: agg.unchanged },
      };
    }
    const candidateMean = agg.candSum / agg.n;
    const baselineMean = agg.baseSum / agg.n;
    return {
      name,
      version,
      valueType,
      direction,
      candidateMean,
      baselineMean,
      delta: candidateMean - baselineMean,
      pairedCount: agg.n,
    };
  });

  const comparison: RunComparison = {
    available,
    trustworthy,
    state: deriveComparisonState(available, trustworthy, reasons),
    reasons,
    baseline: baseline
      ? {
          runId: baseline.id,
          runNumber: baseline.runNumber,
          candidateVersion: baseline.candidateVersion,
        }
      : null,
    scoreCellCounts,
    scorers,
    duration: {
      candidateMeanMs: durPairs > 0 ? durCandSum / durPairs : null,
      baselineMeanMs: durPairs > 0 ? durBaseSum / durPairs : null,
      deltaMs: durPairs > 0 ? (durCandSum - durBaseSum) / durPairs : null,
      pairedCount: durPairs,
    },
  };

  // Stable result ordering: candidate order first, then baseline-only cases.
  const order = new Map<string, number>();
  candidateResults.forEach((r, i) => order.set(r.testCaseId, i));
  let tail = candidateResults.length;
  for (const r of baselineResults) if (!order.has(r.testCaseId)) order.set(r.testCaseId, tail++);
  results.sort((a, b) => (order.get(a.testCaseId) ?? 0) - (order.get(b.testCaseId) ?? 0));

  return { comparison, results };
}
