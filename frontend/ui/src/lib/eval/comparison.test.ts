import { describe, it, expect } from "vitest";
import {
  compareRuns,
  type ComparisonRun,
  type ComparisonResult,
  type ComparisonScore,
  type ComparisonScorerMeta,
  type CompareRunsInput,
} from "./comparison";

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
    mainScore: opts.mainScore ?? null,
    candidateOutput: opts.candidateOutput ?? null,
    durationMs: opts.durationMs ?? null,
    scores: opts.scores ?? [],
  };
}

function run(opts: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    id: opts.id ?? "run_cand",
    runNumber: opts.runNumber ?? 2,
    evaluationId: opts.evaluationId ?? "eval_1",
    datasetVersionId: opts.datasetVersionId ?? "dsv_1",
    candidateVersion: opts.candidateVersion ?? "sonnet",
    status: opts.status ?? "completed",
    mainScore: opts.mainScore ?? null,
    mainScoreName: opts.mainScoreName ?? "acc",
    baselineRunId: opts.baselineRunId === undefined ? "run_base" : opts.baselineRunId,
    scorers: opts.scorers ?? [{ name: "acc", version: "unversioned" }],
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
          result("a", { mainScore: 0.9, scores: [num("acc", 0.9)] }),
          result("b", { mainScore: 0.2, scores: [num("acc", 0.2)] }),
          result("c", { mainScore: 0.5, scores: [num("acc", 0.5)] }),
        ],
        baselineResults: [
          result("a", { mainScore: 0.5, scores: [num("acc", 0.5)] }),
          result("b", { mainScore: 0.8, scores: [num("acc", 0.8)] }),
          result("c", { mainScore: 0.5, scores: [num("acc", 0.5)] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.a.caseChange).toBe("improved");
    expect(byCase.a.mainScore.delta).toBeCloseTo(0.4);
    expect(byCase.b.caseChange).toBe("regressed");
    expect(byCase.c.caseChange).toBe("unchanged");
    expect(out.comparison.caseCounts).toMatchObject({ improved: 1, regressed: 1, unchanged: 1 });
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
        candidate: run({ mainScoreName: "latency", scorers }),
        baseline: run({ id: "run_base", runNumber: 1, mainScoreName: "latency", scorers }),
        candidateResults: [result("a", { mainScore: 100, scores: [num("latency", 100, "v1")] })],
        baselineResults: [result("a", { mainScore: 200, scores: [num("latency", 200, "v1")] })],
      }),
    );
    expect(out.results[0].caseChange).toBe("improved");
    expect(out.results[0].scorerCells[0].delta).toBe(-100);
  });
});

// ── boolean ───────────────────────────────────────────────────────────────

describe("boolean main scorer", () => {
  it("false→true is improved, true→false is regressed (higher-is-better)", () => {
    const scorers: ComparisonScorerMeta[] = [{ name: "pass", version: "v1", valueType: "boolean" }];
    const out = compareRuns(
      build({
        candidate: run({ mainScoreName: "pass", scorers }),
        baseline: run({ id: "run_base", runNumber: 1, mainScoreName: "pass", scorers }),
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
    expect(byCase.up.caseChange).toBe("improved");
    expect(byCase.down.caseChange).toBe("regressed");
    expect(byCase.same.caseChange).toBe("unchanged");
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
        candidate: run({ mainScoreName: "label", scorers }),
        baseline: run({ id: "run_base", runNumber: 1, mainScoreName: "label", scorers }),
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
    expect(byCase.x.caseChange).toBe("unchanged");
    expect(byCase.y.caseChange).toBe("changed");
    expect(byCase.y.scorerCells[0].transition).toEqual({ from: "billing", to: "general" });
    expect(byCase.y.scorerCells[0].delta).toBeNull();
    // Never improved/regressed for a categorical scorer.
    expect(out.comparison.caseCounts.regressed).toBe(0);
    expect(out.comparison.caseCounts.improved).toBe(0);
    expect(out.comparison.caseCounts.changed).toBe(1);
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
          result("a", { mainScore: 1, scores: [num("acc", 1)] }),
          result("only_cand", { mainScore: 1, scores: [num("acc", 1)] }),
        ],
        baselineResults: [
          result("a", { mainScore: 1, scores: [num("acc", 1)] }),
          result("only_base", { mainScore: 1, scores: [num("acc", 1)] }),
        ],
      }),
    );
    const byCase = Object.fromEntries(out.results.map((r) => [r.testCaseId, r]));
    expect(byCase.only_cand.pairing).toBe("candidate_only");
    expect(byCase.only_cand.caseChange).toBe("unpaired");
    expect(byCase.only_base.pairing).toBe("baseline_only");
    expect(byCase.only_base.caseChange).toBe("unpaired");
    expect(byCase.only_base.candidateOutput).toBeNull();
    expect(out.comparison.caseCounts.unpaired).toBe(2);
    expect(out.comparison.caseCounts.unchanged).toBe(1); // only "a"
  });
});

// ── missing scorer on one side (paired case) ──────────────────────────────

describe("missing scorer on one side", () => {
  it("marks that cell unpaired without affecting the main-scorer case verdict", () => {
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
            mainScore: 1,
            scores: [num("acc", 1, "v1"), num("extra", 0.5, "v1")],
          }),
        ],
        baselineResults: [result("a", { mainScore: 1, scores: [num("acc", 1, "v1")] })],
      }),
    );
    const cells = Object.fromEntries(out.results[0].scorerCells.map((c) => [c.scorerName, c]));
    expect(cells.acc.classification).toBe("unchanged");
    expect(cells.extra.classification).toBe("unpaired");
    expect(cells.extra.reason).toBe("baseline_missing");
    expect(out.results[0].caseChange).toBe("unchanged"); // main scorer only
    expect(out.comparison.scoreCellCounts.unpaired).toBe(1);
  });
});

// ── changed scorer version ────────────────────────────────────────────────

describe("changed scorer version", () => {
  it("never computes a trusted delta across versions", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { mainScore: 0.9, scores: [num("acc", 0.9, "v2")] })],
        baselineResults: [result("a", { mainScore: 0.5, scores: [num("acc", 0.5, "v1")] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("version_mismatch");
    expect(cell.delta).toBeNull();
    expect(out.results[0].caseChange).toBe("not_comparable");
    // No paired main-scorer cell was comparable → flagged.
    expect(out.comparison.trustworthy).toBe(false);
    expect(out.comparison.reasons).toContain("main_scorer_incompatible");
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
            mainScore: null,
            scores: [score("acc", { error: "judge failed" })],
          }),
        ],
        baselineResults: [result("a", { mainScore: 1, scores: [num("acc", 1)] })],
      }),
    );
    const cell = out.results[0].scorerCells[0];
    expect(cell.classification).toBe("not_comparable");
    expect(cell.reason).toBe("candidate_error");
    expect(cell.candidateValue).toBeNull(); // not coerced to 0
    expect(out.results[0].caseChange).toBe("not_comparable");
  });

  it("a task error (errored status, no scores) yields an unpaired/not_comparable main cell", () => {
    const out = compareRuns(
      build({
        candidateResults: [result("a", { status: "errored", candidateOutput: null, scores: [] })],
        baselineResults: [result("a", { mainScore: 1, scores: [num("acc", 1)] })],
      }),
    );
    // The candidate has no acc score → the acc cell is unpaired (candidate side missing).
    const cell = out.results[0].scorerCells.find((c) => c.scorerName === "acc")!;
    expect(cell.classification).toBe("unpaired");
    expect(out.results[0].caseChange).not.toBe("unchanged");
  });
});

// ── run-level comparability ──────────────────────────────────────────────

describe("run comparability", () => {
  it("no baseline → unavailable with reason no_baseline", () => {
    const out = compareRuns(
      build({
        candidate: run({ baselineRunId: null }),
        baseline: null,
        candidateResults: [result("a", { mainScore: 1, scores: [num("acc", 1)] })],
      }),
    );
    expect(out.comparison.available).toBe(false);
    expect(out.comparison.trustworthy).toBe(false);
    expect(out.comparison.reasons).toEqual(["no_baseline"]);
    expect(out.results[0].caseChange).toBe("unpaired");
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
        candidateResults: [result("a", { mainScore: 0.9, scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { mainScore: 0.5, scores: [num("acc", 0.5)] })],
      }),
    );
    expect(out.comparison.available).toBe(true);
    expect(out.comparison.trustworthy).toBe(false);
    expect(out.comparison.reasons).toContain("different_dataset_version");
    // It still shows what changed.
    expect(out.results[0].caseChange).toBe("improved");
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
        candidateResults: [result("a", { mainScore: 0.9, scores: [num("acc", 0.9)] })],
        baselineResults: [result("a", { mainScore: 0.5, scores: [num("acc", 0.5)] })],
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
          result("a", { mainScore: 1, scores: [num("acc", 1, "v1")] }),
          result("b", { mainScore: 0, scores: [num("acc", 0, "v1")] }),
          result("c", { scores: [score("acc", { error: "boom", scorerVersion: "v1" })] }),
        ],
        baselineResults: [
          result("a", { mainScore: 1, scores: [num("acc", 1, "v1")] }),
          result("b", { mainScore: 1, scores: [num("acc", 1, "v1")] }),
          result("c", { mainScore: 1, scores: [num("acc", 1, "v1")] }),
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
        mainScore: 1,
        candidateOutput: '{"route":"technical"}',
        scores: cellScores(1, 1, 1),
      }),
    );
    // Candidate (sonnet): identical except ticket-05 misrouted to a still-valid category
    // → routing_accuracy 0, routing_report 0, is_known_category stays 1.
    const candidateResults = CASES.map((id) => {
      const regress = id === "ticket-05";
      return result(id, {
        mainScore: regress ? 0 : 1,
        candidateOutput: regress ? '{"route":"general"}' : '{"route":"technical"}',
        scores: cellScores(regress ? 0 : 1, regress ? 0 : 1, 1),
      });
    });

    const out = compareRuns({
      candidate: run({
        id: "run_sonnet",
        runNumber: 2,
        candidateVersion: "sonnet",
        mainScore: 6 / 7,
        mainScoreName: "routing_accuracy",
        baselineRunId: "run_opus",
        scorers: SCORERS,
      }),
      baseline: run({
        id: "run_opus",
        runNumber: 1,
        candidateVersion: "opus",
        mainScore: 1,
        mainScoreName: "routing_accuracy",
        baselineRunId: null,
        scorers: SCORERS,
      }),
      candidateResults,
      baselineResults,
    });

    expect(out.comparison.available).toBe(true);
    expect(out.comparison.trustworthy).toBe(true);
    expect(out.comparison.reasons).toEqual([]);

    // 1 regressed test case (by the main scorer).
    expect(out.comparison.caseCounts).toMatchObject({
      improved: 0,
      regressed: 1,
      unchanged: 6,
      unpaired: 0,
      not_comparable: 0,
    });

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
    expect(t5.caseChange).toBe("regressed");
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

    // Run-level main-score delta agrees with the main-scorer case result.
    expect(out.comparison.mainScore.delta).toBeCloseTo(6 / 7 - 1); // ≈ -0.142857
    expect(out.comparison.mainScore.delta).toBeLessThan(0);

    // Per-scorer aggregate denominators.
    const acc = out.comparison.scorers.find((s) => s.name === "routing_accuracy")!;
    expect(acc.pairedCount).toBe(7);
    expect(acc.candidateMean).toBeCloseTo(6 / 7);
    expect(acc.baselineMean).toBeCloseTo(1);
  });
});
