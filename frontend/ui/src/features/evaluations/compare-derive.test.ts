import { describe, it, expect } from "vitest";
import {
  deriveVerdict,
  matchesFilter,
  filterCounts,
  sortCases,
  caseStatus,
  type CaseFilterId,
} from "./compare-derive";
import type { CompareResultRow, RunComparison } from "./types";
import { deriveComparisonState } from "@/lib/eval/comparison";

function counts(p: Partial<RunComparison["caseCounts"]> = {}) {
  return {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    changed: 0,
    unpaired: 0,
    not_comparable: 0,
    ...p,
  };
}
function comparison(p: Partial<RunComparison> = {}): RunComparison {
  const merged = {
    available: true,
    trustworthy: true,
    reasons: [],
    baseline: { runId: "b", runNumber: 1, candidateVersion: "opus" },
    mainScore: { candidate: null, baseline: null, delta: null },
    caseCounts: counts(),
    scoreCellCounts: counts(),
    scorers: [],
    duration: { candidateMeanMs: null, baselineMeanMs: null, deltaMs: null, pairedCount: 0 },
    ...p,
  } satisfies Omit<RunComparison, "state"> & Partial<Pick<RunComparison, "state">>;
  // Keep `state` consistent with whatever available/trustworthy/reasons the test set,
  // unless the test pinned it explicitly.
  return {
    ...merged,
    state: p.state ?? deriveComparisonState(merged.available, merged.trustworthy, merged.reasons),
  };
}

// Minimal case row builder.
function row(p: Partial<CompareResultRow> = {}): CompareResultRow {
  return {
    testCaseId: "tc",
    input: "in",
    expectedOutput: null,
    metadata: null,
    provenance: null,
    inputMatchesDataset: true,
    candidateStatus: "passed",
    baselineStatus: "passed",
    candidateOutput: "billing",
    baselineOutput: "billing",
    candidateTraceId: "tc-cand",
    baselineTraceId: "tc-base",
    candidateCost: null,
    baselineCost: null,
    candidateTaskError: null,
    baselineTaskError: null,
    candidateScores: [],
    baselineScores: [],
    outputChanged: false,
    change: "unchanged",
    comparison: {
      caseChange: "unchanged",
      pairing: "paired",
      mainScore: { candidate: 1, baseline: 1, delta: 0 },
      baselineOutput: "billing",
      durationMs: null,
      baselineDurationMs: null,
      durationDeltaMs: null,
      baselineTraceId: "tc-base",
      scorerCells: [],
      regressedCellCount: 0,
      comparableCellCount: 1,
    },
    ...p,
  };
}

describe("deriveVerdict", () => {
  it("regression: main score down", () => {
    const v = deriveVerdict(
      comparison({
        mainScore: { candidate: 6 / 7, baseline: 1, delta: 6 / 7 - 1 },
        caseCounts: counts({ regressed: 1, unchanged: 6 }),
        scoreCellCounts: counts({ regressed: 2, unchanged: 19 }),
      }),
      "completed",
      "completed",
    );
    expect(v.verdict).toBe("regression");
    expect(v.reasons.join(" ")).toMatch(/decreased by 14\.3 pp/);
    expect(v.reasons.join(" ")).toMatch(/1 of 7 test cases regressed/);
    expect(v.reasons.join(" ")).toMatch(/2 scorer values regressed/);
  });

  it("improvement: main up, no regressions", () => {
    const v = deriveVerdict(
      comparison({
        mainScore: { candidate: 1, baseline: 0.8, delta: 0.2 },
        caseCounts: counts({ improved: 2, unchanged: 5 }),
      }),
      "completed",
      "completed",
    );
    expect(v.verdict).toBe("improvement");
  });

  it("tradeoff: quality up but ops worsened", () => {
    const v = deriveVerdict(
      comparison({ mainScore: { candidate: 1, baseline: 0.8, delta: 0.2 } }),
      "completed",
      "completed",
      true,
    );
    expect(v.verdict).toBe("tradeoff");
    expect(v.reasons.join(" ")).toMatch(/duration\/cost increased/);
  });

  it("tie: everything flat", () => {
    const v = deriveVerdict(
      comparison({ mainScore: { candidate: 1, baseline: 1, delta: 0 } }),
      "completed",
      "completed",
    );
    expect(v.verdict).toBe("tie");
  });

  it("not_comparable: different dataset version, with reason", () => {
    const v = deriveVerdict(
      comparison({ reasons: ["different_dataset_version"], trustworthy: false }),
      "completed",
      "completed",
    );
    expect(v.verdict).toBe("not_comparable");
    expect(v.reasons[0]).toMatch(/different immutable dataset versions/);
  });

  it("pending: a run is still running", () => {
    const v = deriveVerdict(comparison(), "running", "completed");
    expect(v.verdict).toBe("pending");
  });
});

describe("filters + counts", () => {
  const rows = [
    row({
      testCaseId: "reg",
      change: "regressed",
      comparison: {
        ...row().comparison!,
        caseChange: "regressed",
        regressedCellCount: 2,
        mainScore: { candidate: 0, baseline: 1, delta: -1 },
      },
    }),
    row({
      testCaseId: "imp",
      change: "improved",
      comparison: { ...row().comparison!, caseChange: "improved" },
    }),
    row({ testCaseId: "err", candidateTaskError: "boom" }),
    row({ testCaseId: "out", outputChanged: true, candidateOutput: "x", baselineOutput: "y" }),
    row({ testCaseId: "same" }),
  ];
  it("each filter selects the right rows", () => {
    const ids = (f: CaseFilterId) =>
      rows.filter((r) => matchesFilter(r, f)).map((r) => r.testCaseId);
    expect(ids("regressions")).toEqual(["reg"]);
    expect(ids("improvements")).toEqual(["imp"]);
    expect(ids("errors")).toEqual(["err"]);
    expect(ids("changed_outputs")).toEqual(["out"]);
    expect(ids("all")).toHaveLength(5);
  });
  it("filterCounts labels", () => {
    const c = filterCounts(rows);
    expect(c.all).toBe(5);
    expect(c.regressions).toBe(1);
    expect(c.errors).toBe(1);
  });
});

describe("default sort", () => {
  it("orders task errors, then main regressions, then improvements, then unchanged", () => {
    const rows = [
      row({ testCaseId: "same" }),
      row({ testCaseId: "imp", comparison: { ...row().comparison!, caseChange: "improved" } }),
      row({ testCaseId: "reg", comparison: { ...row().comparison!, caseChange: "regressed" } }),
      row({ testCaseId: "err", candidateTaskError: "boom" }),
    ];
    expect(sortCases(rows, "default").map((r) => r.testCaseId)).toEqual([
      "err",
      "reg",
      "imp",
      "same",
    ]);
  });
});

describe("caseStatus distinguishes task vs scorer error", () => {
  it("task error", () => {
    expect(caseStatus(row({ candidateTaskError: "boom" }))).toBe("task_error");
  });
  it("scorer error (not a task error)", () => {
    const r = row({
      candidateScores: [
        {
          scorerName: "s",
          scorerVersion: "v1",
          numericValue: null,
          boolValue: null,
          stringValue: null,
          passed: null,
          explanation: null,
          error: "judge failed",
        },
      ],
      comparison: { ...row().comparison!, caseChange: "not_comparable" },
    });
    expect(caseStatus(r)).toBe("scorer_error");
  });
});
