/**
 * Dataset coverage — which slice of the pinned dataset version a run measured.
 *
 * One derivation, shared by every surface that shows or reasons about coverage (the
 * read routes, the run/dataset views, and the comparison adapter), because the failure
 * mode here is two surfaces describing the same run differently. A `--first 20` run
 * against a 500-case version is indistinguishable from a full run unless the SDK says
 * so, and the four stored columns are all-or-nothing: an SDK that declares nothing —
 * or a row written before coverage existed — is UNKNOWN, never quietly "full".
 *
 * The distinction that matters everywhere downstream: `full` is the only mode whose
 * numbers stand on their own. A subset's aggregates describe a slice, and unknown
 * coverage describes a slice of unknown size, so neither is final.
 */

/** `unknown` is not a wire value — it is the read-model reading of an absent block. */
export type CoverageMode = "full" | "first" | "sample" | "unknown";

export interface RunCoverage {
  mode: CoverageMode;
  /** The pinned version's true size. Null exactly when `mode` is `unknown`. */
  datasetCaseCount: number | null;
  /** How many cases the run set out to measure. Null exactly when `mode` is `unknown`. */
  selectedCaseCount: number | null;
  /** Present only for a seeded `sample`; a sample may legitimately be unseeded. */
  sampleSeed: number | null;
}

/** The stored columns, structurally typed so this need not import Prisma. */
export interface StoredRunCoverage {
  datasetCaseCount: number | null;
  selectionMode: string | null;
  selectedCaseCount: number | null;
  /** BIGINT in Postgres, so Prisma reads it back as a `bigint`. */
  sampleSeed: number | bigint | null;
}

const DECLARED_MODES = new Set(["full", "first", "sample"]);

export const UNKNOWN_COVERAGE: RunCoverage = {
  mode: "unknown",
  datasetCaseCount: null,
  selectedCaseCount: null,
  sampleSeed: null,
};

/**
 * Read a run row's coverage. Anything short of a complete, recognised declaration
 * degrades to `unknown` rather than to a guess: a half-written row (only reachable by
 * writing outside the contract) and an unrecognised future mode both describe a run
 * whose coverage this version cannot vouch for, and claiming otherwise is the exact
 * defect coverage exists to fix.
 */
export function toRunCoverage(row: StoredRunCoverage): RunCoverage {
  const { selectionMode, datasetCaseCount, selectedCaseCount, sampleSeed } = row;
  if (
    selectionMode === null ||
    !DECLARED_MODES.has(selectionMode) ||
    datasetCaseCount === null ||
    selectedCaseCount === null
  ) {
    return UNKNOWN_COVERAGE;
  }
  return {
    mode: selectionMode as CoverageMode,
    datasetCaseCount,
    selectedCaseCount,
    // A seed on a non-sample is refused at the contract; drop it here too so no
    // surface can render "first … seed 7" from a row written around the contract. The
    // contract bounds a seed to a safe integer, so the conversion is exact.
    sampleSeed: selectionMode === "sample" && sampleSeed !== null ? Number(sampleSeed) : null,
  };
}

/** True only when the run PROVABLY measured the whole pinned version. */
export function coversFullDataset(coverage: RunCoverage): boolean {
  return coverage.mode === "full";
}

/**
 * A KNOWN partial run: it recorded selecting fewer cases than the dataset holds, by the
 * caller's choice. A `--first 500` of a 500-case version selected everything, so it is
 * not one; nor is a run whose coverage is unknown.
 */
export function isSubset(coverage: RunCoverage): boolean {
  return (
    (coverage.mode === "first" || coverage.mode === "sample") &&
    coverage.selectedCaseCount !== null &&
    coverage.datasetCaseCount !== null &&
    coverage.selectedCaseCount < coverage.datasetCaseCount
  );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The one-line label every surface shows, so coverage reads identically wherever it
 * appears. Plain words rather than mode names, because a reader should not need to know
 * the SDK's flags to understand what a run covered:
 *   All 500 cases
 *   Ran 20 of 500 cases · first 20
 *   Ran 20 of 500 cases · random sample (seed 7)
 *   Coverage unknown
 *
 * A `first`/`sample` run that selected every case is not a subset (see `isSubset`), so
 * it reads exactly like a full run rather than as "Ran 500 of 500".
 */
export function formatCoverage(coverage: RunCoverage): string {
  const { mode, datasetCaseCount, selectedCaseCount, sampleSeed } = coverage;
  if (mode === "unknown") return "Coverage unknown";
  if (mode === "full" || !isSubset(coverage)) return `All ${plural(datasetCaseCount ?? 0, "case")}`;
  const how =
    mode === "first"
      ? `first ${selectedCaseCount}`
      : `random sample${sampleSeed != null ? ` (seed ${sampleSeed})` : ""}`;
  return `Ran ${selectedCaseCount} of ${plural(datasetCaseCount ?? 0, "case")} · ${how}`;
}

/** The compact `20 / 500` form for a table cell; "—" when nothing is known. */
export function formatCoverageRatio(coverage: RunCoverage): string {
  if (coverage.mode === "unknown") return "—";
  return `${coverage.selectedCaseCount} / ${coverage.datasetCaseCount}`;
}

/**
 * What a reader should know about a run's coverage — null for a full run. For a
 * tooltip/label.
 *
 * Only a KNOWN subset is a caveat on the numbers. Unknown coverage is information, not a
 * downgrade: every run recorded before coverage existed, and every SDK that does not
 * report it, lands there, and those runs read exactly as they always have.
 */
export function coverageNote(coverage: RunCoverage): string | null {
  if (coverage.mode === "unknown") {
    return "This run didn't report how many dataset cases it ran.";
  }
  if (isSubset(coverage)) {
    const n = coverage.selectedCaseCount ?? 0;
    const these = n === 1 ? "this 1 case" : `these ${n} cases`;
    return `Averages here cover only ${these}, not the whole dataset.`;
  }
  return null;
}

/** What `runShortfall` needs from a run; structural so the read routes can pass rows. */
export interface RunCompleteness {
  status: string;
  /** What the run declared it would run. For a subset this may be the dataset's size. */
  caseCount: number;
  /** How many result rows the run actually stored — NOT how many a capped response returned. */
  resultCount: number;
  coverage: RunCoverage;
}

/**
 * A run that ended early: it stored fewer results than it set out to run. Null when it
 * did not, or when it is still running (its results are still arriving, so a shortfall
 * says nothing yet). A failed or cancelled run is exactly the case this exists for.
 *
 * What it set out to run is the declared selection when coverage is known — a
 * `--first 20` run set out to run 20, whatever its `caseCount` says — and the run's own
 * `caseCount` otherwise. Judged against `resultCount`, the stored total, so an API cap on
 * the returned rows never reads as a run ending early; that is `resultsTruncated`'s job.
 */
export function runShortfall(run: RunCompleteness): { reported: number; expected: number } | null {
  if (run.status === "running") return null;
  const expected =
    run.coverage.mode === "unknown"
      ? run.caseCount
      : (run.coverage.selectedCaseCount ?? run.caseCount);
  if (!(expected > 0) || run.resultCount >= expected) return null;
  return { reported: run.resultCount, expected };
}
