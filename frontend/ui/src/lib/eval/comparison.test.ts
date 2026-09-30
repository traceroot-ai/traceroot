import { describe, it, expect } from "vitest";
import {
  compareRuns,
  deriveComparisonState,
  type ComparisonRun,
  type ComparisonResult,
  type ComparisonScore,
  type ComparisonScorerMeta,
  type CompareRunsInput,
} from "./comparison";
import type { RunCoverage } from "./coverage";

// ── builders ─────────────────────────────────────────────────────────────

function score(name: string, opts: Partial<ComparisonScore> = {}): ComparisonScore {
  return {
    scorerName: name,
    scorerVersion: opts.scorerVersion ?? "unversioned",
    numericValue: opts.numericValue ?? null,
    boolValue: opts.boolValue ?? null,
    stringValue: opts.stringValue ?? null,
    error: opts.error ?? null,
  };
}
const num = (name: string, v: number, version = "unversioned") =>
  score(name, { numericValue: v, scorerVersion: version });

function result(testCaseId: string, opts: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    testCaseId,
    status: opts.status ?? "passed",
    candidateOutput: opts.candidateOutput ?? null,
    durationMs: opts.durationMs ?? null,
    scores: opts.scores ?? [],
  };
}

/** Coverage builders — the four readings, spelled out where a test needs one. */
const fullCoverage = (n = 10): RunCoverage => ({
  mode: "full",
  datasetCaseCount: n,
  selectedCaseCount: n,
  sampleSeed: null,
});
const firstCoverage = (selected: number, total = 500): RunCoverage => ({
  mode: "first",
  datasetCaseCount: total,
  selectedCaseCount: selected,
  sampleSeed: null,
});
const sampleCoverage = (selected: number, seed: number, total = 500): RunCoverage => ({
  mode: "sample",
  datasetCaseCount: total,
  selectedCaseCount: selected,
  sampleSeed: seed,
});
const unknownCoverage = (): RunCoverage => ({
  mode: "unknown",
  datasetCaseCount: null,
  selectedCaseCount: null,
  sampleSeed: null,
});

function run(opts: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    id: opts.id ?? "run_cand",
    runNumber: opts.runNumber ?? 2,
    evaluationId: opts.evaluationId ?? "eval_1",
    datasetVersionId: opts.datasetVersionId ?? "dsv_1",
    candidateVersion: opts.candidateVersion ?? "sonnet",
    status: opts.status ?? "completed",
    baselineRunId: opts.baselineRunId === undefined ? "run_base" : opts.baselineRunId,
    scorers: opts.scorers ?? [{ name: "acc", version: "unversioned" }],
    // Unknown by default, as every run recorded today is: the pre-existing cases then
    // prove that a comparison between coverage-less runs is unchanged. The coverage
    // suite below overrides it deliberately.
    coverage: opts.coverage ?? unknownCoverage(),
  };
}

function build(over: Partial<CompareRunsInput> = {}): CompareRunsInput {
  return {
    candidate: over.candidate ?? run(),
    candidateResults: over.candidateResults ?? [],
    baseline: over.baseline === undefined ? run({ id: "run_base", runNumber: 1 }) : over.baseline,
    baselineResults: over.baselineResults ?? [],
  };
}

// ── numeric, higher-is-better ─────────────────────────────────────────────

describe("numeric higher-is-better", () => {
  it("classifies improved / regressed / unchanged by the sign of the delta", () => {
    const out = compareRuns(
      build({
        candidateResults: [
          result("a", { scores: [num("acc", 0.9)] }),
          result("b", { scores: [num("acc", 0.2)] }),
          result("c", { scores: [num("acc", 0.5)] }),
        ],
        baselineResults: [
          result("a", { scores: [num("acc", 0.5)] }),
          result("b", { scores: [num("acc", 0.8)] }),
          result("c", { scores: [num("acc", 0.5)] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.a.scorerCells[0].classification).toBe("improved");
    expect(byCase.a.scorerCells[0].delta).toBeCloseTo(0.4);
    expect(byCase.b.scorerCells[0].classification).toBe("regressed");
    expect(byCase.c.scorerCells[0].classification).toBe("unchanged");
    expect(out.comparison.scoreCellCounts).toMatchObject({
      improved: 1,
      regressed: 1,
      unchanged: 1,
    });
    expect(out.comparison.scoreCellCounts).toMatchObject({
      improved: 1,
      regressed: 1,
      unchanged: 1,
    });
  });
});

describe("numeric lower-is-better", () => {
  it("flips the direction (a smaller candidate is an improvement)", () => {
    const scorers: ComparisonScorerMeta[] = [
      { name: "latency", version: "v1", valueType: "numeric", direction: "lower_is_better" },
    ];
    const out = compareRuns(
      build({
        candidate: run({ scorers }),
        baseline: run({ id: "run_base", runNumber: 1, scorers }),
        candidateResults: [result("a", { scores: [num("latency", 100, "v1")] })],
        baselineResults: [result("a", { scores: [num("latency", 200, "v1")] })],
      }),
    );
    expect(out.results[0].scorerCells[0].classification).toBe("improved");
    expect(out.results[0].scorerCells[0].delta).toBe(-100);
  });
});

// ── boolean ───────────────────────────────────────────────────────────────

describe("boolean scorer", () => {
  it("false→true is improved, true→false is regressed (higher-is-better)", () => {
    const scorers: ComparisonScorerMeta[] = [{ name: "pass", version: "v1", valueType: "boolean" }];
    const out = compareRuns(
      build({
        candidate: run({ scorers }),
        baseline: run({ id: "run_base", runNumber: 1, scorers }),
        candidateResults: [
          result("up", { scores: [score("pass", { boolValue: true, scorerVersion: "v1" })] }),
          result("down", { scores: [score("pass", { boolValue: false, scorerVersion: "v1" })] }),
          result("same", { scores: [score("pass", { boolValue: true, scorerVersion: "v1" })] }),
        ],
        baselineResults: [
          result("up", { scores: [score("pass", { boolValue: false, scorerVersion: "v1" })] }),
          result("down", { scores: [score("pass", { boolValue: true, scorerVersion: "v1" })] }),
          result("same", { scores: [score("pass", { boolValue: true, scorerVersion: "v1" })] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.up.scorerCells[0].classification).toBe("improved");
    expect(byCase.down.scorerCells[0].classification).toBe("regressed");
    expect(byCase.same.scorerCells[0].classification).toBe("unchanged");
    // Boolean values preserved for display.
    expect(byCase.up.scorerCells[0].candidateValue).toBe(true);
    expect(byCase.up.scorerCells[0].baselineValue).toBe(false);
  });
});

// ── categorical ─────────────────────────────────────────────────────────

describe("categorical (direction none)", () => {
  it("returns a baseline→candidate transition; changed is not a regression", () => {
    const scorers: ComparisonScorerMeta[] = [
      { name: "label", version: "v1", valueType: "categorical" },
    ];
    const out = compareRuns(
      build({
        candidate: run({ scorers }),
        baseline: run({ id: "run_base", runNumber: 1, scorers }),
        candidateResults: [
          result("x", {
            scores: [score("label", { stringValue: "billing", scorerVersion: "v1" })],
          }),
          result("y", {
            scores: [score("label", { stringValue: "general", scorerVersion: "v1" })],
          }),
        ],
        baselineResults: [
          result("x", {
            scores: [score("label", { stringValue: "billing", scorerVersion: "v1" })],
          }),
          result("y", {
            scores: [score("label", { stringValue: "billing", scorerVersion: "v1" })],
          }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.x.scorerCells[0].classification).toBe("unchanged");
    expect(byCase.y.scorerCells[0].classification).toBe("changed");
    expect(byCase.y.scorerCells[0].transition).toEqual({ from: "billing", to: "general" });
    expect(byCase.y.scorerCells[0].delta).toBeNull();
    // Never improved/regressed for a categorical scorer.
    expect(out.comparison.scoreCellCounts.regressed).toBe(0);
    expect(out.comparison.scoreCellCounts.improved).toBe(0);
    expect(out.comparison.scoreCellCounts.changed).toBe(1);
    const agg = out.comparison.scorers.find((s) => s.name === "label")!;
    expect(agg.transitions).toEqual({ changed: 1, unchanged: 1 });
    expect(agg.candidateMean).toBeNull();
  });
});

// ── missing case on one side ──────────────────────────────────────────────

describe("missing case on one side", () => {
  it("is unpaired, never unchanged", () => {
    const out = compareRuns(
      build({
        candidateResults: [
          result("a", { scores: [num("acc", 1)] }),
          result("only_cand", { scores: [num("acc", 1)] }),
        ],
        baselineResults: [
          result("a", { scores: [num("acc", 1)] }),
          result("only_base", { scores: [num("acc", 1)] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.only_cand.pairing).toBe("candidate_only");
    expect(byCase.only_cand.scorerCells[0].classification).toBe("unpaired");
    expect(byCase.only_base.pairing).toBe("baseline_only");
    expect(byCase.only_base.scorerCells[0].classification).toBe("unpaired");
    expect(byCase.only_base.candidateOutput).toBeNull();
    expect(out.comparison.scoreCellCounts.unpaired).toBe(2);
    expect(out.comparison.scoreCellCounts.unchanged).toBe(1); // only "a"
  });
});

// ── missing scorer on one side (paired case) ──────────────────────────────

describe("missing scorer on one side", () => {
  it("marks that cell not_comparable (the case IS paired) without affecting the other scorers' cells", () => {
    const out = compareRuns(
      build({
        candidate: run({
          scorers: [
            { name: "acc", version: "v1" },
            { name: "extra", version: "v1" },
          ],
        }),
        candidateResults: [
          result("a", {
            scores: [num("acc", 1, "v1"), num("extra", 0.5, "v1")],
          }),
        ],
        baselineResults: [result("a", { scores: [num("acc", 1, "v1")] })],
      }),
    );
    const cells = Object.fromEntries(out.results[0].scorerCells.map((c) => [c.scorerName, c]));
    expect(cells.acc.classification).toBe("unchanged");
    // The case exists on both sides — only the "extra" scorer's value is missing on
    // the baseline — so this is `not_comparable`, never `unpaired` (that's reserved
    // for a case that isn't in both runs at all).
    expect(cells.extra.classification).toBe("not_comparable");
    expect(cells.extra.reason).toBe("baseline_missing");
    expect(out.results[0].scorerCells[0].classification).toBe("unchanged"); // the single scorer's cell
    expect(out.comparison.scoreCellCounts.not_comparable).toBe(1);
    expect(out.comparison.scoreCellCounts.unpaired).toBe(0);
  });
});

// ── changed scorer version ────────────────────────────────────────────────

describe("changed scorer version", () => {
  it("never computes a trusted delta across versions", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { scores: [num("acc", 0.9, "v2")] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5, "v1")] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("version_mismatch");
    expect(cell.delta).toBeNull();
    // Metric-first: an incomparable cell is shown per-cell; there is no run-level
    // single-scorer gate, and the per-metric aggregate simply carries no delta.
    expect(out.comparison.scorers[0].delta).toBeNull();
  });
});

// ── task error / scorer error ─────────────────────────────────────────────

describe("errors are explicit, never zero", () => {
  it("a scorer error makes the cell not_comparable (not a 0)", () => {
    const out = compareRuns(
      build({
        candidateResults: [
          result("a", {
            status: "passed",
            scores: [score("acc", { error: "judge failed" })],
          }),
        ],
        baselineResults: [result("a", { scores: [num("acc", 1)] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("candidate_error");
    expect(cell.candidateValue).toBeNull(); // not coerced to 0
    expect(out.results[0].scorerCells[0].classification).toBe("not_comparable");
  });

  it("a task error (errored status, no scores) yields a not_comparable main cell — the case IS paired, so it must never land in `unpaired`", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { status: "errored", candidateOutput: null, scores: [] })],
        baselineResults: [result("a", { scores: [num("acc", 1)] })],
      }),
    );
    // The case exists in both runs — the candidate's task just errored and produced no
    // acc score. `not_comparable` (candidate_missing), never `unpaired`: `unpaired`
    // means "not in both runs", and this case is, so a crash here must not be
    // indistinguishable from a case that's simply absent from the baseline.
    const cell = out.results[0].scorerCells.find((c) => c.scorerName === "acc")!;
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("candidate_missing");
    expect(out.results[0].scorerCells[0].classification).not.toBe("unchanged");
    expect(out.results[0].scorerCells[0].classification).not.toBe("unpaired");
    expect(out.comparison.scoreCellCounts.unpaired).toBe(0);
  });
});

// ── run-level comparability ──────────────────────────────────────────────

describe("run comparability", () => {
  it("no baseline → unavailable with reason no_baseline", () => {
    const out = compareRuns(
      build({
        candidate: run({ baselineRunId: null }),
        baseline: null,
        candidateResults: [result("a", { scores: [num("acc", 1)] })],
      }),
    );
    expect(out.comparison.available).toBe(false);
    expect(out.comparison.trustworthy).toBe(false);
    expect(out.comparison.reasons).toEqual(["no_baseline"]);
    expect(out.results[0].scorerCells[0].classification).toBe("unpaired");
  });

  it("baseline_run_id set but baseline not found → baseline_missing", () => {
    const out = compareRuns(
      build({ candidate: run({ baselineRunId: "run_base" }), baseline: null }),
    );
    expect(out.comparison.reasons).toEqual(["baseline_missing"]);
  });

  it("different dataset version → available but not trustworthy", () => {
    const out = compareRuns(
      build({
        baseline: run({ id: "run_base", runNumber: 1, datasetVersionId: "dsv_OTHER" }),
        candidateResults: [result("a", { scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.available).toBe(true);
    expect(out.comparison.trustworthy).toBe(false);
    expect(out.comparison.reasons).toContain("different_dataset_version");
    // It still shows what changed.
    expect(out.results[0].scorerCells[0].classification).toBe("improved");
  });

  it("different evaluation → not trustworthy", () => {
    const out = compareRuns(
      build({ baseline: run({ id: "run_base", runNumber: 1, evaluationId: "eval_OTHER" }) }),
    );
    expect(out.comparison.reasons).toContain("different_evaluation");
  });

  it("incomplete/running baseline → baseline_not_terminal", () => {
    const out = compareRuns(
      build({
        baseline: run({ id: "run_base", runNumber: 1, status: "running" }),
        candidateResults: [result("a", { scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.reasons).toContain("baseline_not_terminal");
    expect(out.comparison.trustworthy).toBe(false);
  });
});

// ── per-scorer aggregate denominators ─────────────────────────────────────

describe("per-scorer aggregate uses paired, successfully-scored cells only", () => {
  it("excludes errored/missing/unpaired cells symmetrically and reports the denominator", () => {
    const out = compareRuns(
      build({
        candidate: run({ scorers: [{ name: "acc", version: "v1" }] }),
        candidateResults: [
          result("a", { scores: [num("acc", 1, "v1")] }),
          result("b", { scores: [num("acc", 0, "v1")] }),
          result("c", { scores: [score("acc", { error: "boom", scorerVersion: "v1" })] }),
        ],
        baselineResults: [
          result("a", { scores: [num("acc", 1, "v1")] }),
          result("b", { scores: [num("acc", 1, "v1")] }),
          result("c", { scores: [num("acc", 1, "v1")] }),
        ],
      }),
    );
    const agg = out.comparison.scorers.find((s) => s.name === "acc")!;
    expect(agg.pairedCount).toBe(2); // c excluded (candidate errored)
    expect(agg.candidateMean).toBeCloseTo(0.5); // (1 + 0) / 2
    expect(agg.baselineMean).toBeCloseTo(1); // (1 + 1) / 2
    expect(agg.delta).toBeCloseTo(-0.5);
  });
});

// ── duration ──────────────────────────────────────────────────────────────

describe("duration comparison", () => {
  it("returns per-case candidate/baseline duration + delta, and a paired case-duration mean", () => {
    const out = compareRuns(
      build({
        candidateResults: [
          result("a", { durationMs: 1200, scores: [num("acc", 1)] }),
          result("b", { durationMs: 800, scores: [num("acc", 1)] }),
          result("c", { durationMs: null, scores: [num("acc", 1)] }), // unknown
        ],
        baselineResults: [
          result("a", { durationMs: 1000, scores: [num("acc", 1)] }),
          result("b", { durationMs: 900, scores: [num("acc", 1)] }),
          result("c", { durationMs: 700, scores: [num("acc", 1)] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.a.durationMs).toBe(1200);
    expect(byCase.a.baselineDurationMs).toBe(1000);
    expect(byCase.a.durationDeltaMs).toBe(200);
    // Unknown candidate duration → delta null, never 0.
    expect(byCase.c.durationMs).toBeNull();
    expect(byCase.c.durationDeltaMs).toBeNull();
    // Aggregate case-duration mean over the two paired-with-both-known cases (a, b).
    expect(out.comparison.duration.pairedCount).toBe(2);
    expect(out.comparison.duration.candidateMeanMs).toBe((1200 + 800) / 2);
    expect(out.comparison.duration.baselineMeanMs).toBe((1000 + 900) / 2);
    expect(out.comparison.duration.deltaMs).toBe((1200 + 800 - 1000 - 900) / 2);
  });
});

// ── the seven-case lab ────────────────────────────────────────────────────

describe("seven-case ticket-routing lab", () => {
  const SCORERS: ComparisonScorerMeta[] = [
    { name: "routing_accuracy", version: "unversioned" },
    { name: "routing_report", version: "unversioned" },
    { name: "is_known_category", version: "unversioned" },
  ];
  const CASES = [
    "ticket-00",
    "ticket-01",
    "ticket-02",
    "ticket-03",
    "ticket-04",
    "ticket-05",
    "ticket-06",
  ];

  function cellScores(routing: number, report: number, known: number): ComparisonScore[] {
    return [
      num("routing_accuracy", routing),
      num("routing_report", report),
      num("is_known_category", known),
    ];
  }

  it("derives 1 regressed case, 2 regressed cells, 0 improved, 19 unchanged, delta ≈ -0.143", () => {
    // Baseline (opus): every case correct → all scorers 1.0.
    const baselineResults = CASES.map((id) =>
      result(id, {
        candidateOutput: '{"route":"technical"}',
        scores: cellScores(1, 1, 1),
      }),
    );
    // Candidate (sonnet): identical except ticket-05 misrouted to a still-valid category
    // → routing_accuracy 0, routing_report 0, is_known_category stays 1.
    const candidateResults = CASES.map((id) => {
      const regress = id === "ticket-05";
      return result(id, {
        candidateOutput: regress ? '{"route":"general"}' : '{"route":"technical"}',
        scores: cellScores(regress ? 0 : 1, regress ? 0 : 1, 1),
      });
    });

    const out = compareRuns({
      candidate: run({
        id: "run_sonnet",
        runNumber: 2,
        candidateVersion: "sonnet",
        baselineRunId: "run_opus",
        scorers: SCORERS,
      }),
      baseline: run({
        id: "run_opus",
        runNumber: 1,
        candidateVersion: "opus",
        baselineRunId: null,
        scorers: SCORERS,
      }),
      candidateResults,
      baselineResults,
    });

    expect(out.comparison.available).toBe(true);
    expect(out.comparison.trustworthy).toBe(true);
    expect(out.comparison.reasons).toEqual([]);

    // Metric-first: there is no single per-case verdict — only per-scorer-cell counts.
    // 2 regressed score cells, 0 improved, 19 unchanged (21 total).
    expect(out.comparison.scoreCellCounts).toMatchObject({
      improved: 0,
      regressed: 2,
      unchanged: 19,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    });
    const cellTotal = Object.values(out.comparison.scoreCellCounts).reduce((a, b) => a + b, 0);
    expect(cellTotal).toBe(21);

    // ticket-05 shows both affected scorers regressed with baseline/candidate values.
    const t5 = out.results.find((r) => r.testCaseId === "ticket-05")!;
    expect(t5.scorerCells[0].classification).toBe("regressed");
    const t5cells = Object.fromEntries(t5.scorerCells.map((c) => [c.scorerName, c]));
    expect(t5cells.routing_accuracy).toMatchObject({
      classification: "regressed",
      candidateValue: 0,
      baselineValue: 1,
      delta: -1,
    });
    expect(t5cells.routing_report).toMatchObject({ classification: "regressed", delta: -1 });
    expect(t5cells.is_known_category.classification).toBe("unchanged");
    expect(t5.regressedCellCount).toBe(2);

    // The routing_accuracy metric's mean delta over the 7 paired cases (6/7 − 1).
    expect(out.comparison.scorers[0].delta).toBeCloseTo(6 / 7 - 1); // ≈ -0.142857
    expect(out.comparison.scorers[0].delta).toBeLessThan(0);

    // Per-scorer aggregate denominators.
    const acc = out.comparison.scorers.find((s) => s.name === "routing_accuracy")!;
    expect(acc.pairedCount).toBe(7);
    expect(acc.candidateMean).toBeCloseTo(6 / 7);
    expect(acc.baselineMean).toBeCloseTo(1);
  });
});

// ── cross-side / declared-vs-observed type drift ───────────────────────────

describe("cross-side type mismatch", () => {
  it("a numeric candidate value against a categorical baseline value is not_comparable, never a fabricated verdict", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { scores: [score("acc", { stringValue: "good" })] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("type_mismatch");
    expect(cell.delta).toBeNull();
    expect(out.results[0].scorerCells[0].classification).toBe("not_comparable");
    // Excluded from the aggregate denominator, not silently coerced into it.
    expect(out.comparison.scorers.find((s) => s.name === "acc")?.pairedCount ?? 0).toBe(0);
  });

  it("a declared boolean scorer whose stored values are actually numeric is compared as numeric, not coerced through truthiness", () => {
    const scorers: ComparisonScorerMeta[] = [{ name: "acc", version: "v1", valueType: "boolean" }];
    const out = compareRuns(
      build({
        candidate: run({ scorers }),
        baseline: run({ id: "run_base", runNumber: 1, scorers }),
        candidateResults: [result("a", { scores: [num("acc", 0.3, "v1")] })],
        baselineResults: [result("a", { scores: [num("acc", 0.9, "v1")] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    // Both sides are observed as numeric despite the declared metadata — the delta
    // reflects the real numbers, not a `value ? 1 : 0` coercion that would collapse
    // both truthy values to "unchanged".
    expect(cell.delta).toBeCloseTo(-0.6);
    expect(cell.classification).toBe("regressed");
  });
});

describe("non-finite stored values", () => {
  it("a non-finite numeric value can never yield a directional verdict or feed a mean", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { scores: [num("acc", NaN)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("not_scored");
    expect(cell.delta).toBeNull();
    expect(out.comparison.scorers.find((s) => s.name === "acc")?.pairedCount ?? 0).toBe(0);
  });
});

// ── per-metric mean delta ───────────────────────────────────────────────

describe("per-metric mean delta is derived from paired cells, never a raw run-aggregate subtraction", () => {
  it("agrees with the paired scorer aggregate even when the two runs declare different scorer sets", () => {
    const bothScorers: ComparisonScorerMeta[] = [
      { name: "acc", version: "v1" },
      { name: "f1", version: "v1" },
    ];
    const out = compareRuns(
      build({
        candidate: run({
          scorers: bothScorers,
        }),
        baseline: run({
          id: "run_base",
          runNumber: 1,
          scorers: bothScorers,
        }),
        candidateResults: [result("a", { scores: [num("acc", 1, "v1"), num("f1", 1, "v1")] })],
        baselineResults: [result("a", { scores: [num("acc", 1, "v1"), num("f1", 1, "v1")] })],
      }),
    );
    // The `acc` metric is aggregated over paired cells; both runs scored it identically
    // → the paired mean delta is 0, never a raw subtraction of two runs' reported numbers.
    expect(out.comparison.scorers[0].delta).toBe(0);
  });

  it("agrees with the paired scorer aggregate even when the two runs scored only partially-overlapping case sets", () => {
    const out = compareRuns(
      build({
        candidate: run({}),
        baseline: run({ id: "run_base", runNumber: 1 }),
        candidateResults: [
          result("a", { scores: [num("acc", 1)] }),
          result("b", { scores: [num("acc", 1)] }),
        ],
        baselineResults: [
          result("a", { scores: [num("acc", 1)] }),
          result("b", { scores: [num("acc", 1)] }),
          result("c", { scores: [num("acc", 0)] }),
        ],
      }),
    );
    // Paired cases (a, b) are unchanged on the merits — delta 0 — even though the
    // runs' raw reported numbers (1.0 vs 0.667) would subtract to +0.333.
    expect(out.comparison.scorers[0].delta).toBe(0);
    expect(out.comparison.scoreCellCounts.unpaired).toBe(1); // "c" is baseline-only
    expect(out.comparison.reasons).toContain("case_set_mismatch");
    expect(out.comparison.trustworthy).toBe(false);
  });
});

// ── run-level trust: candidate status, non-terminal statuses, case-set drift ──

describe("candidate_not_terminal", () => {
  it("a live/running candidate is not trustworthy even against a terminal baseline", () => {
    const out = compareRuns(
      build({
        candidate: run({ status: "running" }),
        baseline: run({ id: "run_base", runNumber: 1 }),
        candidateResults: [result("a", { scores: [num("acc", 1)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.reasons).toContain("candidate_not_terminal");
    expect(out.comparison.trustworthy).toBe(false);
  });
});

describe("incomplete/cancelled runs are not terminal for comparison purposes", () => {
  it("a cancelled baseline is flagged, not silently treated as a complete result set", () => {
    const out = compareRuns(
      build({
        baseline: run({ id: "run_base", runNumber: 1, status: "cancelled" }),
        candidateResults: [result("a", { scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.reasons).toContain("baseline_not_terminal");
    expect(out.comparison.trustworthy).toBe(false);
  });

  it("an incomplete candidate is flagged the same way", () => {
    const out = compareRuns(
      build({
        candidate: run({ status: "incomplete" }),
        candidateResults: [result("a", { scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.reasons).toContain("candidate_not_terminal");
    expect(out.comparison.trustworthy).toBe(false);
  });
});

describe("case_set_mismatch", () => {
  it("flags a comparison where most cases are unpaired, even though the scorer is otherwise comparable", () => {
    const candidateResults = [
      result("a", { scores: [num("acc", 1)] }),
      ...Array.from({ length: 9 }, (_, i) => result(`only_cand_${i}`, { scores: [num("acc", 1)] })),
    ];
    const out = compareRuns(
      build({
        candidateResults,
        baselineResults: [result("a", { scores: [num("acc", 1)] })],
      }),
    );
    expect(out.comparison.scoreCellCounts.unpaired).toBe(9);
    expect(out.comparison.reasons).toContain("case_set_mismatch");
    expect(out.comparison.trustworthy).toBe(false);
  });
});

// ── deterministic dedup of duplicate scorer rows ────────────────────────────

describe("duplicate scorer rows for the same scorer name (a version bump or a delayed re-score)", () => {
  it("picks a winner deterministically, independent of the input array order", () => {
    const forward = compareRuns(
      build({
        candidateResults: [result("a", { scores: [num("acc", 0.5, "v1"), num("acc", 0.9, "v2")] })],
        baselineResults: [result("a", { scores: [num("acc", 0.9, "v2")] })],
      }),
    );
    const reversed = compareRuns(
      build({
        candidateResults: [result("a", { scores: [num("acc", 0.9, "v2"), num("acc", 0.5, "v1")] })],
        baselineResults: [result("a", { scores: [num("acc", 0.9, "v2")] })],
      }),
    );
    // Same outcome regardless of row order — the higher scorerVersion ("v2") wins,
    // never whichever row happened to come first in an unordered DB read.
    expect(forward.results[0].scorerCells[0]).toEqual(reversed.results[0].scorerCells[0]);
    expect(forward.results[0].scorerCells[0].classification).toBe("unchanged");
    expect(forward.results[0].scorerCells[0].candidateValue).toBe(0.9);
  });
});

describe("deriveComparisonState (four-state discriminant)", () => {
  it("unavailable when there is no baseline", () => {
    expect(deriveComparisonState(false, false, ["no_baseline"])).toBe("unavailable");
    expect(deriveComparisonState(false, false, ["baseline_missing"])).toBe("unavailable");
  });
  it("trustworthy only when available with no reasons", () => {
    expect(deriveComparisonState(true, true, [])).toBe("trustworthy");
  });
  it("pending when a run is not terminal", () => {
    expect(deriveComparisonState(true, false, ["candidate_not_terminal"])).toBe("pending");
    expect(deriveComparisonState(true, false, ["baseline_not_terminal"])).toBe("pending");
  });
  it("exploratory for a computed-but-incompatible comparison (different evaluation, etc.)", () => {
    expect(deriveComparisonState(true, false, ["different_evaluation"])).toBe("exploratory");
    expect(deriveComparisonState(true, false, ["different_dataset_version"])).toBe("exploratory");
    expect(deriveComparisonState(true, false, ["case_set_mismatch"])).toBe("exploratory");
  });
  it("pending wins when a run is both not-terminal and would be incompatible", () => {
    expect(
      deriveComparisonState(true, false, ["candidate_not_terminal", "different_evaluation"]),
    ).toBe("pending");
  });
});

describe("dataset coverage and trust", () => {
  /** Two runs over the SAME case ids, so nothing but coverage can disqualify them. */
  const pairOver = (ids: string[], candidate: RunCoverage, baseline: RunCoverage) =>
    compareRuns(
      build({
        candidate: run({ coverage: candidate }),
        baseline: run({ id: "run_base", runNumber: 1, coverage: baseline }),
        candidateResults: ids.map((id) => result(id, { scores: [num("acc", 1)] })),
        baselineResults: ids.map((id) => result(id, { scores: [num("acc", 0.5)] })),
      }),
    ).comparison;

  it("trusts two runs that both provably covered the whole dataset", () => {
    const c = pairOver(["a", "b"], fullCoverage(2), fullCoverage(2));
    expect(c.reasons).toEqual([]);
    expect(c.trustworthy).toBe(true);
    expect(c.state).toBe("trustworthy");
  });

  it("refuses to trust two IDENTICAL subsets — the hole matching case sets left open", () => {
    // The shape a CLI encourages: the same `--first 20` in a loop while iterating. The
    // two runs pair perfectly (unpairedCases = 0), are both terminal and share a dataset
    // version, so every other check passes and this used to read as an authoritative
    // verdict at 4% coverage. Matching case sets say the runs agree about those cases;
    // they say nothing about the dataset.
    const c = pairOver(["a", "b"], firstCoverage(20), firstCoverage(20));
    expect(c.reasons).not.toContain("case_set_mismatch");
    expect(c.reasons).toContain("partial_coverage");
    expect(c.trustworthy).toBe(false);
    expect(c.state).toBe("exploratory");
  });

  it("refuses two identically-seeded samples for the same reason", () => {
    const c = pairOver(["a", "b"], sampleCoverage(20, 7), sampleCoverage(20, 7));
    expect(c.reasons).toContain("partial_coverage");
    expect(c.trustworthy).toBe(false);
  });

  it("disqualifies a subset on either side", () => {
    expect(pairOver(["a", "b"], firstCoverage(20), fullCoverage(2)).reasons).toContain(
      "partial_coverage",
    );
    expect(pairOver(["a", "b"], fullCoverage(2), firstCoverage(20)).reasons).toContain(
      "partial_coverage",
    );
  });

  it("leaves a comparison between two coverage-less runs exactly as it was", () => {
    // Every run recorded before coverage existed, and every run from an SDK that does
    // not report it, lands here. Unknown coverage is neutral: the verdict is the one the
    // engine gave before coverage existed — the same as two full runs.
    const c = pairOver(["a", "b"], unknownCoverage(), unknownCoverage());
    expect(c.reasons).toEqual([]);
    expect(c.trustworthy).toBe(true);
    expect(c.state).toBe("trustworthy");
    expect(c).toEqual(pairOver(["a", "b"], fullCoverage(2), fullCoverage(2)));
  });

  it("keeps unknown coverage neutral beside a full run on either side", () => {
    for (const [cand, base] of [
      [unknownCoverage(), fullCoverage(2)],
      [fullCoverage(2), unknownCoverage()],
    ]) {
      const c = pairOver(["a", "b"], cand, base);
      expect(c.reasons).toEqual([]);
      expect(c.trustworthy).toBe(true);
    }
  });

  it("still downgrades a known subset compared against an unknown-coverage run", () => {
    const c = pairOver(["a", "b"], firstCoverage(20), unknownCoverage());
    expect(c.reasons).toEqual(["partial_coverage"]);
    expect(c.trustworthy).toBe(false);
  });

  it("does not count a first/sample run that selected every case as partial", () => {
    const c = pairOver(["a", "b"], firstCoverage(500), sampleCoverage(500, 7));
    expect(c.reasons).toEqual([]);
    expect(c.trustworthy).toBe(true);
  });

  it("changes the verdict only for a known partial run: none/none, none/full, none/partial, partial/full", () => {
    // `none` is a run with no recorded coverage — every run today.
    const none = unknownCoverage();
    const partial = firstCoverage(20);
    const full = fullCoverage(2);
    const mainVerdict = { reasons: [], trustworthy: true, state: "trustworthy" };
    expect(pairOver(["a", "b"], none, none)).toMatchObject(mainVerdict);
    expect(pairOver(["a", "b"], none, full)).toMatchObject(mainVerdict);
    expect(pairOver(["a", "b"], full, none)).toMatchObject(mainVerdict);
    const downgraded = {
      reasons: ["partial_coverage"],
      trustworthy: false,
      state: "exploratory",
    };
    expect(pairOver(["a", "b"], none, partial)).toMatchObject(downgraded);
    expect(pairOver(["a", "b"], partial, none)).toMatchObject(downgraded);
    expect(pairOver(["a", "b"], partial, full)).toMatchObject(downgraded);
    expect(pairOver(["a", "b"], full, partial)).toMatchObject(downgraded);
  });

  it("reports a partial run once, not once per side", () => {
    const c = pairOver(["a", "b"], firstCoverage(20), firstCoverage(20));
    expect(c.reasons.filter((r) => r === "partial_coverage")).toHaveLength(1);
  });

  it("leaves the arithmetic alone — only the verdict changes", () => {
    // Trust is separate from the deltas: a subset comparison is still computed and
    // still correct ABOUT ITS SUBSET; it just may not be read as a dataset verdict.
    const full = pairOver(["a", "b"], fullCoverage(2), fullCoverage(2));
    const subset = pairOver(["a", "b"], firstCoverage(20), firstCoverage(20));
    expect(subset.scorers).toEqual(full.scorers);
    expect(subset.scoreCellCounts).toEqual(full.scoreCellCounts);
  });

  it("keeps the existing compatibility checks intact alongside coverage", () => {
    // A different dataset version still disqualifies, and still reports its own reason,
    // whatever the coverage says.
    const c = compareRuns(
      build({
        candidate: run({ coverage: fullCoverage(2) }),
        baseline: run({
          id: "run_base",
          runNumber: 1,
          datasetVersionId: "dsv_2",
          coverage: fullCoverage(2),
        }),
        candidateResults: [result("a", { scores: [num("acc", 1)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    ).comparison;
    expect(c.reasons).toContain("different_dataset_version");
    expect(c.reasons).not.toContain("partial_coverage");
  });

  it("still says pending, not exploratory, when a subset run is also unfinished", () => {
    // A non-terminal run is pending until it settles — "still running" stays the more
    // actionable state even once coverage has an opinion.
    const c = compareRuns(
      build({
        candidate: run({ status: "running", coverage: firstCoverage(20) }),
        baseline: run({ id: "run_base", runNumber: 1, coverage: fullCoverage(2) }),
        candidateResults: [result("a", { scores: [num("acc", 1)] })],
        baselineResults: [result("a", { scores: [num("acc", 0.5)] })],
      }),
    ).comparison;
    expect(c.reasons).toContain("candidate_not_terminal");
    expect(c.reasons).toContain("partial_coverage");
    expect(c.state).toBe("pending");
  });

  it("does not manufacture coverage reasons when there is no baseline to compare", () => {
    const c = compareRuns(
      build({
        candidate: run({ baselineRunId: null, coverage: unknownCoverage() }),
        baseline: null,
        candidateResults: [result("a", { scores: [num("acc", 1)] })],
      }),
    ).comparison;
    expect(c.reasons).toEqual(["no_baseline"]);
    expect(c.state).toBe("unavailable");
  });
});

describe("deriveComparisonState with coverage reasons", () => {
  it("maps a coverage disqualification to exploratory", () => {
    expect(deriveComparisonState(true, false, ["partial_coverage"])).toBe("exploratory");
  });
});
