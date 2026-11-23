import { describe, expect, it } from "vitest";
import {
  buildCompareModel,
  comparePairs,
  countCellsByScorer,
  expectedKeyOf,
  pairExclusions,
  type CompareModel,
} from "./model";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
  POLICY,
  QUALITY,
  ROUTE,
  fixtureResult,
  fixtureRun,
  fixtureScore,
  scorerManifest,
} from "./__tests__/paired-fixture";

const otherDataset = { datasetId: "ds2", datasetName: "tickets-v2", datasetVersionId: "dv2" };
const scored = (v: number) => [fixtureScore(QUALITY, v)];

/** The case each run fills, row by row: `[row key, { runId: candidateOutput }]`. */
const filled = (model: CompareModel) =>
  model.cases.map((c) => [
    c.key,
    Object.fromEntries([...c.byRun].map(([runId, r]) => [runId, r.candidateOutput])),
  ]);

describe("buildCompareModel — runs and baseline", () => {
  it("defaults the baseline to the oldest run and orders the rest oldest to newest", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    expect(model.baselineRunId).toBe(BASELINE_RUN.id);
    expect(model.runs.map((b) => b.run.id)).toEqual([
      BASELINE_RUN.id,
      CANDIDATE_RUN.id,
      FAST_RUN.id,
    ]);
  });

  it("puts a chosen baseline first, then the others oldest to newest", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, FAST_RUN.id);
    expect(model.baselineRunId).toBe(FAST_RUN.id);
    expect(model.runs.map((b) => b.run.id)).toEqual([
      FAST_RUN.id,
      BASELINE_RUN.id,
      CANDIDATE_RUN.id,
    ]);
  });

  it("falls back to the oldest run when the chosen baseline is not among the runs", () => {
    expect(buildCompareModel(PAIRED_FIXTURE, "gone").baselineRunId).toBe(BASELINE_RUN.id);
  });

  it("is empty, not broken, before any run has loaded", () => {
    const model = buildCompareModel([], null);
    expect(model.runs).toEqual([]);
    expect(model.cases).toEqual([]);
    expect(comparePairs(model).size).toBe(0);
  });
});

describe("buildCompareModel — cases", () => {
  it("keeps the union of cases, baseline order first, and counts the ones every run has", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    expect(model.alignment).toBe("case_id");
    expect(model.cases).toHaveLength(12);
    // Baseline rows first (case 10 is not in the baseline), then the candidates' extras.
    expect(model.cases.map((c) => c.byRun.get(FAST_RUN.id)?.testCaseId)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].map((n) => `case-${n}`),
      "case-10",
    ]);
    // Case 9 is missing from #2 and case 10 from #1.
    expect(model.sharedByAllCount).toBe(10);
  });

  it("aligns runs on the baseline's dataset by case id, even when an input was edited", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z", { datasetName: "renamed" });
    const model = buildCompareModel(
      [
        { run: a, results: [fixtureResult("a", "tc-1", "original", scored(1))] },
        { run: b, results: [fixtureResult("b", "tc-1", "edited", scored(0))] },
      ],
      "a",
    );
    expect(model.alignment).toBe("case_id");
    expect(filled(model)).toEqual([["id:tc-1", { a: "a output", b: "b output" }]]);
  });

  it("aligns a run on another dataset by canonical input", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const model = buildCompareModel(
      [
        { run: a, results: [fixtureResult("a", "tc-1", '{"q":1,"lang":"en"}', scored(1))] },
        // Different dataset → different case ids; same input with its keys reordered.
        { run: x, results: [fixtureResult("x", "tc-other", '{"lang":"en","q":1}', scored(0))] },
      ],
      "a",
    );
    expect(model.alignment).toBe("canonical_input");
    expect(filled(model)).toEqual([["id:tc-1", { a: "a output", x: "x output" }]]);
    expect(model.sharedByAllCount).toBe(1);
  });

  it("keeps a cross-dataset case that matches no baseline input as its own row", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const model = buildCompareModel(
      [
        { run: a, results: [fixtureResult("a", "tc-1", "shared", scored(1))] },
        {
          run: x,
          results: [
            fixtureResult("x", "tc-x1", "shared", scored(1)),
            fixtureResult("x", "tc-x2", "only in x", scored(1)),
          ],
        },
      ],
      "a",
    );
    expect(filled(model)).toEqual([
      ["id:tc-1", { a: "a output", x: "x output" }],
      ['input:s:"only in x"', { x: "x output" }],
    ]);
    expect(model.sharedByAllCount).toBe(1);
  });

  it("keeps a baseline's duplicate-input rows distinct and fills both with a lone cross case", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "dup-a", "Hello", scored(1), { candidateOutput: "a1" }),
            fixtureResult("a", "dup-b", "Hello", scored(0), { candidateOutput: "a2" }),
          ],
        },
        { run: x, results: [fixtureResult("x", "x1", "Hello", scored(1))] },
      ],
      "a",
    );
    expect(filled(model)).toEqual([
      ["id:dup-a", { a: "a1", x: "x output" }],
      ["id:dup-b", { a: "a2", x: "x output" }],
    ]);
  });

  it("keeps a same-dataset pair on case ids when a cross-dataset run joins", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z");
    const c = fixtureRun("c", 3, "c", "2026-11-03T00:00:00Z", otherDataset);
    const out = (run: string, tc: string) => ({ candidateOutput: `${run}-${tc}` });
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "case-1", "Hello", scored(1), out("a", "case-1")),
            fixtureResult("a", "case-2", "Hello", scored(1), out("a", "case-2")),
          ],
        },
        {
          run: b,
          results: [
            fixtureResult("b", "case-1", "Hello", scored(1), out("b", "case-1")),
            // An edited input on the same dataset still pairs by id.
            fixtureResult("b", "case-2", "Hello again", scored(0), out("b", "case-2")),
          ],
        },
        { run: c, results: [fixtureResult("c", "tc-y", "Hello", scored(1), out("c", "tc-y"))] },
      ],
      "a",
    );
    expect(filled(model)).toEqual([
      ["id:case-1", { a: "a-case-1", b: "b-case-1", c: "c-tc-y" }],
      ["id:case-2", { a: "a-case-2", b: "b-case-2", c: "c-tc-y" }],
    ]);
    expect(model.sharedByAllCount).toBe(2);
  });

  it("takes only a cross-dataset run's first case for an input it measured twice", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const model = buildCompareModel(
      [
        { run: a, results: [fixtureResult("a", "only-a", "Hello", scored(1))] },
        {
          run: x,
          results: [
            fixtureResult("x", "x1", "Hello", scored(1), { candidateOutput: "first" }),
            fixtureResult("x", "x2", "Hello", scored(0), { candidateOutput: "second" }),
          ],
        },
      ],
      "a",
    );
    expect(filled(model)).toEqual([["id:only-a", { a: "a output", x: "first" }]]);
  });

  it("keeps a string input and a same-text number apart across datasets", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const model = buildCompareModel(
      [
        { run: a, results: [fixtureResult("a", "tc-1", "123", scored(1))] },
        { run: x, results: [fixtureResult("x", "tc-x", '"123"', scored(1))] },
      ],
      "a",
    );
    expect(model.sharedByAllCount).toBe(0);
  });
});

describe("buildCompareModel — scorer columns", () => {
  it("lists every scorer once with its declared or observed type and direction", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    expect(
      model.scorers.map(({ name, valueType, direction }) => ({ name, valueType, direction })),
    ).toEqual([
      { name: POLICY, valueType: "numeric", direction: "lower_is_better" },
      { name: QUALITY, valueType: "numeric", direction: "higher_is_better" },
      { name: ROUTE, valueType: "categorical", direction: "none" },
    ]);
  });

  it("formats each column once, from every value any run reported", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    const format = Object.fromEntries(model.scorers.map((s) => [s.name, s.format.kind]));
    // quality stays within [0,1]; policy_violations reaches 2, so even its 0s read as counts.
    expect(format).toEqual({ [QUALITY]: "proportion", [POLICY]: "number", [ROUTE]: "number" });
  });

  it("takes each declared field from the newest run that declares it", () => {
    // An older SDK recorded scorers as bare `{ name, version }`; a newer run declares the
    // direction. The oldest run is the default baseline, but its missing direction must not
    // hide the newer declaration, and the newest run omitting it again doesn't erase it.
    const old = fixtureRun("old", 1, "old", "2026-11-01T00:00:00Z", {
      scorers: scorerManifest([{ name: "violations", version: "1" }]),
    });
    const upgraded = fixtureRun("new", 2, "new", "2026-11-02T00:00:00Z", {
      scorers: scorerManifest([
        { name: "violations", version: "2", direction: "lower_is_better", value_type: "numeric" },
      ]),
    });
    const newest = fixtureRun("newest", 3, "newest", "2026-11-03T00:00:00Z", {
      scorers: scorerManifest([{ name: "violations", version: "2" }]),
    });
    const v = (n: number) => [fixtureScore("violations", n)];
    const model = buildCompareModel(
      [
        {
          run: old,
          results: [
            fixtureResult("old", "tc-1", "one", v(0)),
            fixtureResult("old", "tc-2", "two", v(0)),
          ],
        },
        {
          run: upgraded,
          results: [
            fixtureResult("new", "tc-1", "one", v(2)),
            fixtureResult("new", "tc-2", "two", v(0)),
          ],
        },
        { run: newest, results: [fixtureResult("newest", "tc-1", "one", v(0))] },
      ],
      null,
    );
    expect(model.baselineRunId).toBe("old");
    expect(model.scorers).toEqual([
      expect.objectContaining({
        name: "violations",
        valueType: "numeric",
        direction: "lower_is_better",
      }),
    ]);
    // 0 → 2 violations is a regression, never an improvement.
    expect(countCellsByScorer(comparePairs(model).get("new")!).get("violations")).toEqual(
      expect.objectContaining({ improved: 0, regressed: 1, unchanged: 1 }),
    );
  });

  it("formats a column holding true/false values as a proportion", () => {
    // Declared numeric, but every recorded value is a boolean.
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", {
      scorers: scorerManifest([{ name: "exact", version: "1", value_type: "numeric" }]),
    });
    const bool = (value: boolean) => ({ ...fixtureScore("exact", null), boolValue: value });
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "tc-1", "x", [bool(true)]),
            fixtureResult("a", "tc-2", "y", [bool(false)]),
          ],
        },
      ],
      "a",
    );
    expect(model.scorers[0]).toEqual(
      expect.objectContaining({ valueType: "numeric", format: { kind: "proportion" } }),
    );
  });

  it("formats a column from each result's latest score, not from superseded rows", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", {
      scorers: scorerManifest([{ name: "count", version: "2", value_type: "numeric" }]),
    });
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "tc-1", "x", [
              { ...fixtureScore("count", 7), scorerVersion: "1" },
              { ...fixtureScore("count", 0.4), scorerVersion: "2" },
            ]),
          ],
        },
      ],
      "a",
    );
    expect(model.scorers[0].format).toEqual({ kind: "proportion" });
  });

  it("detects boolean and categorical scorers from their values when nothing is declared", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", { scorers: null });
    const bool = { ...fixtureScore("exact", null), boolValue: true };
    const model = buildCompareModel(
      [{ run: a, results: [fixtureResult("a", "tc", "x", [bool, fixtureScore("label", "ok")])] }],
      "a",
    );
    expect(
      model.scorers.map(({ name, valueType, direction }) => ({ name, valueType, direction })),
    ).toEqual([
      { name: "exact", valueType: "boolean", direction: "higher_is_better" },
      { name: "label", valueType: "categorical", direction: "none" },
    ]);
  });
});

describe("comparePairs", () => {
  const model = buildCompareModel(PAIRED_FIXTURE, null);
  const pairs = comparePairs(model);
  const pair = pairs.get(CANDIDATE_RUN.id)!;
  const scorer = (name: string) => pair.comparison.scorers.find((s) => s.name === name)!;

  it("compares every candidate against the baseline", () => {
    expect([...pairs.keys()]).toEqual([CANDIDATE_RUN.id, FAST_RUN.id]);
  });

  it("averages a scorer over the cases both runs scored", () => {
    const quality = scorer(QUALITY);
    expect(quality.pairedCount).toBe(7);
    expect(quality.baselineMean).toBeCloseTo(0.7857, 4);
    expect(quality.candidateMean).toBeCloseTo(0.8214, 4);
    expect(quality.delta).toBeCloseTo(0.0357, 4);
  });

  it("keeps a count scorer's mean as a count, with its declared direction", () => {
    const policy = scorer(POLICY);
    expect(policy.direction).toBe("lower_is_better");
    expect(policy.pairedCount).toBe(8);
    expect(policy.baselineMean).toBe(0);
    expect(policy.candidateMean).toBe(0.25);
  });

  it("counts a categorical scorer's changes instead of averaging it", () => {
    const route = scorer(ROUTE);
    expect(route.candidateMean).toBeNull();
    expect(route.transitions).toEqual({ changed: 1, unchanged: 7 });
  });

  it("averages latency and cost over the cases both runs reported", () => {
    expect(pair.comparison.duration).toEqual({
      baselineMeanMs: 1000,
      candidateMeanMs: 1200,
      deltaMs: 200,
      pairedCount: 10,
    });
    expect(pair.cost.pairedCount).toBe(10);
    expect(pair.cost.baselineMean).toBeCloseTo(0.01, 10);
    expect(pair.cost.candidateMean).toBeCloseTo(0.02, 10);
    expect(pair.cost.delta).toBeCloseTo(0.01, 10);
  });

  it("keys each case comparison by the row key", () => {
    expect([...pair.byCase.keys()].sort()).toEqual(model.cases.map((c) => c.key).sort());
    expect(pair.byCase.get("id:case-9")?.pairing).toBe("baseline_only");
    expect(pair.byCase.get("id:case-10")?.pairing).toBe("candidate_only");
    const case2 = pair.byCase.get("id:case-2")!;
    expect(case2.scorerCells.find((c) => c.scorerName === QUALITY)?.classification).toBe(
      "regressed",
    );
  });

  it("restricts every pair to the given cases", () => {
    const only = comparePairs(model, new Set(["id:case-1", "id:case-2"])).get(CANDIDATE_RUN.id)!;
    expect([...only.byCase.keys()]).toEqual(["id:case-1", "id:case-2"]);
    const quality = only.comparison.scorers.find((s) => s.name === QUALITY)!;
    expect(quality.pairedCount).toBe(2);
    expect(quality.baselineMean).toBeCloseTo((0.4 + 0.85) / 2, 10);
    expect(quality.candidateMean).toBeCloseTo((0.95 + 0.3) / 2, 10);
    expect(only.cost.pairedCount).toBe(2);
  });

  it("pairs a cross-dataset run against every baseline row its input fills", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const x = fixtureRun("x", 2, "x", "2026-11-02T00:00:00Z", otherDataset);
    const cross = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "dup-a", "Hello", scored(1)),
            fixtureResult("a", "dup-b", "Hello", scored(0)),
          ],
        },
        {
          run: x,
          results: [fixtureResult("x", "x1", "Hello", scored(0.5), { durationMs: 3300 })],
        },
      ],
      "a",
    );
    const p = comparePairs(cross).get("x")!;
    const quality = p.comparison.scorers.find((s) => s.name === QUALITY)!;
    expect(quality.pairedCount).toBe(2);
    expect(quality.baselineMean).toBe(0.5);
    expect(p.comparison.duration.candidateMeanMs).toBe(3300);
    expect(p.comparison.duration.pairedCount).toBe(2);
  });
});

describe("pairExclusions", () => {
  it("says why each of the pair's cases is missing from a scorer's paired count", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    const exclusions = pairExclusions(model, comparePairs(model).get(CANDIDATE_RUN.id)!);
    // 7 paired + 5 left out = the 12 cases either run has.
    expect(exclusions.get(QUALITY)).toEqual([
      { reason: "no_result", runId: BASELINE_RUN.id, count: 1 },
      { reason: "no_result", runId: CANDIDATE_RUN.id, count: 1 },
      { reason: "task_error", runId: CANDIDATE_RUN.id, count: 1 },
      { reason: "scorer_error", runId: CANDIDATE_RUN.id, count: 1 },
      { reason: "not_scored", runId: CANDIDATE_RUN.id, count: 1 },
    ]);
    // policy_violations was scored on case 7, so only 4 of the 12 are left out.
    expect(exclusions.get(POLICY)).toEqual([
      { reason: "no_result", runId: BASELINE_RUN.id, count: 1 },
      { reason: "no_result", runId: CANDIDATE_RUN.id, count: 1 },
      { reason: "task_error", runId: CANDIDATE_RUN.id, count: 1 },
      { reason: "not_scored", runId: CANDIDATE_RUN.id, count: 1 },
    ]);
  });

  it("puts a scorer version or value type change on the pair, not on one run", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z", { scorers: null });
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z", { scorers: null });
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "tc-1", "one", [fixtureScore(QUALITY, 0.5)]),
            fixtureResult("a", "tc-2", "two", [fixtureScore(QUALITY, 0.5)]),
          ],
        },
        {
          run: b,
          results: [
            fixtureResult("b", "tc-1", "one", [
              { ...fixtureScore(QUALITY, 0.7), scorerVersion: "2" },
            ]),
            fixtureResult("b", "tc-2", "two", [fixtureScore(QUALITY, "high")]),
          ],
        },
      ],
      "a",
    );
    expect(pairExclusions(model, comparePairs(model).get("b")!).get(QUALITY)).toEqual([
      { reason: "version_mismatch", runId: null, count: 1 },
      { reason: "type_mismatch", runId: null, count: 1 },
    ]);
  });

  it("blames both runs when neither scored a case", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z");
    const c = fixtureRun("c", 3, "c", "2026-11-03T00:00:00Z");
    const failed = { status: "errored" as const, taskError: "boom" };
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "tc-1", "one", scored(1)),
            fixtureResult("a", "tc-2", "two", [], failed),
          ],
        },
        {
          run: b,
          results: [
            fixtureResult("b", "tc-1", "one", scored(1)),
            fixtureResult("b", "tc-2", "two", [], failed),
          ],
        },
        // Only #3 runs the `extra` scorer.
        { run: c, results: [fixtureResult("c", "tc-1", "one", [fixtureScore("extra", 1)])] },
      ],
      "a",
    );
    const exclusions = pairExclusions(model, comparePairs(model).get("b")!);
    expect(exclusions.get(QUALITY)).toEqual([{ reason: "task_error", runId: null, count: 1 }]);
    expect(exclusions.get("extra")).toEqual([
      { reason: "task_error", runId: null, count: 1 },
      { reason: "not_scored", runId: null, count: 1 },
    ]);
  });

  it("gives each case the reason its cells show, blaming both runs when both failed alike", () => {
    const a = fixtureRun("a", 1, "a", "2026-11-01T00:00:00Z");
    const b = fixtureRun("b", 2, "b", "2026-11-02T00:00:00Z");
    const judgeDown = [fixtureScore(QUALITY, null, "judge timed out")];
    const model = buildCompareModel(
      [
        {
          run: a,
          results: [
            fixtureResult("a", "tc-1", "one", judgeDown),
            fixtureResult("a", "tc-2", "two", scored(1)),
            fixtureResult("a", "tc-3", "three", []),
          ],
        },
        {
          run: b,
          results: [
            fixtureResult("b", "tc-1", "one", judgeDown),
            // Errored with no output: the task failed, whether or not it said why.
            fixtureResult("b", "tc-2", "two", [], { status: "errored", candidateOutput: null }),
            fixtureResult("b", "tc-3", "three", judgeDown),
          ],
        },
      ],
      "a",
    );
    expect(pairExclusions(model, comparePairs(model).get("b")!).get(QUALITY)).toEqual([
      { reason: "task_error", runId: "b", count: 1 },
      { reason: "scorer_error", runId: null, count: 1 },
      // Missing before failed, as the comparison itself decides.
      { reason: "not_scored", runId: "a", count: 1 },
    ]);
  });
});

describe("countCellsByScorer", () => {
  it("tallies a pair's case cells per scorer", () => {
    const model = buildCompareModel(PAIRED_FIXTURE, null);
    const counts = countCellsByScorer(comparePairs(model).get(CANDIDATE_RUN.id)!);
    const none = { improved: 0, regressed: 0, unchanged: 0, changed: 0 };
    // Cases 9 and 10 are in one run only; 6, 7 and 8 have no candidate quality value.
    expect(counts.get(QUALITY)).toEqual({
      ...none,
      improved: 6,
      regressed: 1,
      unpaired: 2,
      not_comparable: 3,
    });
    // Two violations where there were none is a regression for a lower-is-better count.
    expect(counts.get(POLICY)).toEqual({
      ...none,
      regressed: 1,
      unchanged: 7,
      unpaired: 2,
      not_comparable: 2,
    });
    expect(counts.get(ROUTE)).toEqual({
      ...none,
      changed: 1,
      unchanged: 7,
      unpaired: 2,
      not_comparable: 2,
    });
  });
});

describe("expectedKeyOf", () => {
  const expecting = (expectedOutput: string | null) =>
    fixtureResult(BASELINE_RUN.id, "case-1", "Ticket 1", [], { expectedOutput });

  it("reads one expected output the same in any form it was recorded in", () => {
    const key = expectedKeyOf(expecting('{"route": "billing", "priority": 1}'));
    expect(expectedKeyOf(expecting('{"priority":1,"route":"billing"}'))).toBe(key);
    expect(expectedKeyOf(expecting('"Reset SSO"'))).toBe(expectedKeyOf(expecting("Reset SSO")));
  });

  it("tells a different expected output, an empty one and none apart", () => {
    const keys = [expecting("Reset SSO"), expecting("Reset MFA"), expecting(""), expecting(null)];
    expect(new Set(keys.map(expectedKeyOf)).size).toBe(4);
  });
});
