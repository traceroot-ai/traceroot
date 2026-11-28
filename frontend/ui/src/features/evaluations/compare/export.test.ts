import { describe, expect, it } from "vitest";
import type { ScoreRow } from "../types";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  fixtureResult,
  fixtureRun,
  fixtureScore,
  PAIRED_FIXTURE,
  POLICY,
  QUALITY,
  ROUTE,
  scorerManifest,
} from "./__tests__/paired-fixture";
import {
  buildComparisonExport,
  exportFileName,
  toCsv,
  toJson,
  type ComparisonExport,
  type ExportRow,
} from "./export";
import { NO_ANALYSIS, type CaseAnalysis } from "./filters";
import { buildCompareModel, type CaseRow, type RunBundle } from "./model";
import { runLabeler, runTagger } from "./run-tags";

const GENERATED_AT = new Date(2026, 10, 11, 14, 5);
const model = buildCompareModel(PAIRED_FIXTURE, null);
// Runs are named as the page names them.
const labelOf = runLabeler(model.runs, runTagger(model.runs));
const rowsFor = (...cases: number[]) =>
  cases.map((n) => model.cases.find((c) => c.key === `id:case-${n}`) as CaseRow);

const build = (rows: readonly CaseRow[], analysis: CaseAnalysis = NO_ANALYSIS) =>
  buildComparisonExport(model, { projectId: "p1", rows, analysis, generatedAt: GENERATED_AT });

const runOf = (row: ExportRow, runId: string) => row.runs.find((r) => r.runId === runId)!;
const scoreOf = (row: ExportRow, runId: string, scorer: string) =>
  runOf(row, runId).scores.find((s) => s.scorer === scorer)!;

describe("buildComparisonExport — rows", () => {
  it("has exactly the given cases, in the given order", () => {
    const { rows } = build(rowsFor(12, 2, 7));
    expect(rows.map((r) => r.case)).toEqual(["id:case-12", "id:case-2", "id:case-7"]);
    expect(rows[0].input).toBe("Ticket 12");
    expect(rows[0].expected).toBeNull();
    // Every run, baseline first, then oldest to newest.
    expect(rows[0].runs.map((r) => r.runId)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("gives each run's output, status, latency and cost as recorded", () => {
    const [row] = build(rowsFor(6)).rows;
    expect(runOf(row, "run-1")).toMatchObject({
      output: "run-1 output",
      status: "passed",
      latencyMs: 1000,
      cost: 0.01,
    });
    expect(runOf(row, "run-2")).toMatchObject({ status: "errored", latencyMs: 1200, cost: 0.02 });
  });

  it("says a run has no result for a case it lacks", () => {
    const [row] = build(rowsFor(9)).rows;
    expect(runOf(row, "run-2")).toMatchObject({
      output: null,
      status: "no_result",
      latencyMs: null,
      cost: null,
    });
  });

  it("gives each run's expected output, and the case's only when every run expects the same", () => {
    const expecting = (runId: string, testCaseId: string, expectedOutput: string) =>
      fixtureResult(runId, testCaseId, testCaseId.toUpperCase(), [], { expectedOutput });
    const bundles: RunBundle[] = [
      {
        run: fixtureRun("b1", 1, "v1", "2026-11-01T10:00:00.000Z"),
        results: [
          expecting("b1", "c1", '{"route":"billing","priority":1}'),
          expecting("b1", "c2", "Refund approved"),
          expecting("b1", "c3", "Escalate"),
        ],
      },
      {
        run: fixtureRun("b2", 2, "v2", "2026-11-02T10:00:00.000Z"),
        results: [
          // The same object with its keys reordered and spaced: the same expected output.
          expecting("b2", "c1", '{ "priority": 1, "route": "billing" }'),
          expecting("b2", "c2", "Refund denied"),
        ],
      },
    ];
    const expModel = buildCompareModel(bundles, null);
    const exp = buildComparisonExport(expModel, {
      projectId: "p1",
      rows: expModel.cases,
      analysis: NO_ANALYSIS,
      generatedAt: GENERATED_AT,
    });
    const [same, differ, oneRun] = exp.rows;
    expect(same.expected).toBe('{"route":"billing","priority":1}');
    expect(same.runs.map((r) => r.expected)).toEqual([
      '{"route":"billing","priority":1}',
      '{ "priority": 1, "route": "billing" }',
    ]);
    expect(differ.expected).toBeNull();
    expect(differ.runs.map((r) => r.expected)).toEqual(["Refund approved", "Refund denied"]);
    // A run without the case expects nothing, so it doesn't disagree.
    expect(oneRun.expected).toBe("Escalate");
    expect(oneRun.runs.map((r) => r.expected)).toEqual(["Escalate", null]);

    const runLabel = runLabeler(expModel.runs, runTagger(expModel.runs));
    const [header, , line] = toCsv(exp)
      .replace("\uFEFF", "")
      .split("\r\n")
      .map((l) => l.split(","));
    const field = (name: string) => line[header.indexOf(name)];
    expect(line[2]).toBe("");
    expect(field(`${runLabel("b1")} · expected`)).toBe("Refund approved");
    expect(field(`${runLabel("b2")} · expected`)).toBe("Refund denied");
  });

  it("gives each score as recorded, with its raw change and the comparison's classification", () => {
    const [one, two, twelve] = build(rowsFor(1, 2, 12)).rows;
    // The baseline's own values carry no change.
    expect(scoreOf(one, "run-1", QUALITY)).toEqual({
      scorer: QUALITY,
      value: 0.4,
      change: null,
      classification: null,
      notCompared: null,
    });
    // 0.95 − 0.4, without floating-point noise.
    expect(scoreOf(one, "run-2", QUALITY)).toMatchObject({
      value: 0.95,
      change: 0.55,
      classification: "improved",
      notCompared: null,
    });
    // A count where lower is better: up by 2 is a regression.
    expect(scoreOf(two, "run-2", POLICY)).toMatchObject({
      value: 2,
      change: 2,
      classification: "regressed",
    });
    // A label that changed reads "from → to"; one that didn't has no change.
    expect(scoreOf(twelve, "run-2", ROUTE)).toMatchObject({
      value: "refunds",
      change: "billing → refunds",
      classification: "changed",
    });
    expect(scoreOf(twelve, "run-3", ROUTE)).toMatchObject({
      value: "billing",
      change: null,
      classification: "unchanged",
    });
  });

  it("says why a value wasn't compared, and in which run", () => {
    const [six, seven, eight, nine, ten] = build(rowsFor(6, 7, 8, 9, 10)).rows;
    expect(scoreOf(six, "run-2", QUALITY)).toMatchObject({
      value: null,
      change: null,
      classification: "not_comparable",
      notCompared: "Task error",
    });
    expect(scoreOf(seven, "run-2", QUALITY).notCompared).toBe("Scorer error");
    expect(scoreOf(eight, "run-2", QUALITY).notCompared).toBe("Not scored");
    expect(scoreOf(nine, "run-2", QUALITY)).toMatchObject({
      classification: "unpaired",
      notCompared: "No result",
    });
    // Case 10 is missing from the baseline, so #2's value has nothing to compare with.
    expect(scoreOf(ten, "run-2", QUALITY)).toMatchObject({
      value: 0.9,
      classification: "unpaired",
      notCompared: "No result in baseline",
    });
  });

  it("names a reason that belongs to neither run alone, and keeps a mismatch's plain", () => {
    const pair = (
      baseline: Partial<Parameters<typeof fixtureResult>[4]>,
      candidate: Partial<Parameters<typeof fixtureResult>[4]>,
      scores: [ScoreRow[], ScoreRow[]],
    ) => {
      const bundles: RunBundle[] = [
        {
          run: fixtureRun("b1", 1, "v1", "2026-11-01T10:00:00.000Z"),
          // A scored case alongside, so the scorer is a column even when c1 has none.
          results: [
            fixtureResult("b1", "c1", "Q1", scores[0], baseline),
            fixtureResult("b1", "c2", "Q2", [fixtureScore(QUALITY, 1)]),
          ],
        },
        {
          run: fixtureRun("b2", 2, "v2", "2026-11-02T10:00:00.000Z"),
          results: [
            fixtureResult("b2", "c1", "Q1", scores[1], candidate),
            fixtureResult("b2", "c2", "Q2", [fixtureScore(QUALITY, 1)]),
          ],
        },
      ];
      const m = buildCompareModel(bundles, null);
      const exp = buildComparisonExport(m, {
        projectId: "p1",
        rows: m.cases,
        analysis: NO_ANALYSIS,
        generatedAt: GENERATED_AT,
      });
      return scoreOf(exp.rows[0], "b2", QUALITY).notCompared;
    };
    const num = (value: number, version = "1"): ScoreRow => ({
      ...fixtureScore(QUALITY, value),
      scorerVersion: version,
    });
    const text = (value: string): ScoreRow => fixtureScore(QUALITY, value);
    const taskError = { status: "errored", taskError: "boom" } as const;
    const scorerError = [fixtureScore(QUALITY, null, "judge timed out")];

    // The same failure on both sides is one reason, said for both runs.
    expect(pair(taskError, taskError, [[], []])).toBe("Task error in both runs");
    expect(pair({}, {}, [scorerError, scorerError])).toBe("Scorer error in both runs");
    // Both recorded a value the comparison can't use: neither run failed.
    expect(pair({}, {}, [[num(Infinity)], [num(1)]])).toBe("Not scored in either run");
    // A mismatch belongs to the pair, so it names no run.
    expect(pair({}, {}, [[num(1)], [num(2, "2")]])).toBe("Version mismatch");
    expect(pair({}, {}, [[num(1)], [text("high")]])).toBe("Type mismatch");
  });

  it("keeps true/false values as recorded and counts them as 1/0 for the change", () => {
    const bool = (value: boolean, version = "1"): ScoreRow => ({
      ...fixtureScore("grounded", null),
      scorerVersion: version,
      boolValue: value,
    });
    const bundles: RunBundle[] = [
      {
        run: fixtureRun("b1", 1, "v1", "2026-11-01T10:00:00.000Z"),
        results: [
          fixtureResult("b1", "c1", "Q1", [bool(true)]),
          fixtureResult("b1", "c2", "Q2", [bool(false)]),
        ],
      },
      {
        run: fixtureRun("b2", 2, "v2", "2026-11-02T10:00:00.000Z"),
        results: [
          fixtureResult("b2", "c1", "Q1", [bool(false)]),
          fixtureResult("b2", "c2", "Q2", [bool(true, "2")]),
        ],
      },
    ];
    const boolModel = buildCompareModel(bundles, null);
    const exp = buildComparisonExport(boolModel, {
      projectId: "p1",
      rows: boolModel.cases,
      analysis: NO_ANALYSIS,
      generatedAt: GENERATED_AT,
    });
    expect(scoreOf(exp.rows[0], "b1", "grounded").value).toBe(true);
    expect(scoreOf(exp.rows[0], "b2", "grounded")).toMatchObject({
      value: false,
      change: -1,
      classification: "regressed",
    });
    // A different scorer version: the value stays, but it isn't compared.
    expect(scoreOf(exp.rows[1], "b2", "grounded")).toMatchObject({
      value: true,
      change: null,
      classification: "not_comparable",
      notCompared: "Version mismatch",
    });
    expect(toCsv(exp)).toContain("\r\nid:c1,Q1,,b1 output,,passed,1000,0.01,true,,,,");
  });
});

describe("buildComparisonExport — a scorer another run records as text", () => {
  it("gives a numeric pair's change, as its summary and table do", () => {
    // Bare `{ name, version }` scorers, so each value type comes from what was recorded.
    const bundles: RunBundle[] = (
      [
        ["a", 1, 0.4],
        ["b", 2, 0.8],
        ["c", 3, "high"],
      ] as const
    ).map(([id, day, value]) => ({
      run: fixtureRun(id, day, id, `2026-11-0${day}T00:00:00Z`, {
        scorers: scorerManifest([{ name: QUALITY, version: "1" }]),
      }),
      results: [fixtureResult(id, "tc-1", "one", [fixtureScore(QUALITY, value)])],
    }));
    const mixed = buildCompareModel(bundles, "a");
    const exp = buildComparisonExport(mixed, {
      projectId: "p1",
      rows: mixed.cases,
      analysis: NO_ANALYSIS,
      generatedAt: GENERATED_AT,
    });
    expect(scoreOf(exp.rows[0], "b", QUALITY)).toMatchObject({
      value: 0.8,
      classification: "improved",
    });
    expect(scoreOf(exp.rows[0], "b", QUALITY).change).toBeCloseTo(0.4);
    // The run that recorded text isn't compared, so it has no change.
    expect(scoreOf(exp.rows[0], "c", QUALITY)).toMatchObject({ value: "high", change: null });
  });
});

describe("buildComparisonExport — meta", () => {
  const analysis: CaseAnalysis = {
    q: "  ticket ",
    filters: [{ kind: "regressed", scorer: QUALITY, runId: "run-2" }],
    sort: { kind: "regression", scorer: QUALITY, runId: "run-2" },
  };

  it("says when it was made, for which project, and on which runs and baseline", () => {
    const { meta } = build(rowsFor(2), analysis);
    expect(meta.generatedAt).toBe(GENERATED_AT.toISOString());
    expect(meta.projectId).toBe("p1");
    expect(meta.baseline).toEqual({ runId: "run-1", label: labelOf("run-1") });
    expect(meta.runs).toEqual([
      {
        id: "run-1",
        label: labelOf("run-1"),
        evaluationName: "support-routing",
        datasetName: "support-tickets",
      },
      {
        id: "run-2",
        label: labelOf("run-2"),
        evaluationName: "support-routing",
        datasetName: "support-tickets",
      },
      {
        id: "run-3",
        label: labelOf("run-3"),
        evaluationName: "support-routing",
        datasetName: "support-tickets",
      },
    ]);
    expect(meta.scorers).toEqual([
      { name: POLICY, valueType: "numeric", direction: "lower_is_better" },
      { name: QUALITY, valueType: "numeric", direction: "higher_is_better" },
      { name: ROUTE, valueType: "categorical", direction: "none" },
    ]);
    expect(meta.alignment).toBe("case_id");
  });

  it("records the search, filters and sort, and how many cases it covers", () => {
    const { meta } = build(rowsFor(2), analysis);
    expect(meta.search).toBe("ticket");
    expect(meta.filters).toEqual([
      {
        kind: "regressed",
        scorer: QUALITY,
        runId: "run-2",
        label: "Regressed · quality · #2",
      },
    ]);
    expect(meta.sort).toEqual({ kind: "regression", scorer: QUALITY, runId: "run-2" });
    expect(meta.counts).toEqual({ matching: 1, total: 12, inAllRuns: 10 });
  });

  it("gives each pair's paired counts and means over exactly these cases", () => {
    const all = build(model.cases).meta.pairs;
    expect(all.map((p) => [p.baselineRunId, p.candidateRunId, p.candidateLabel])).toEqual([
      ["run-1", "run-2", labelOf("run-2")],
      ["run-1", "run-3", labelOf("run-3")],
    ]);
    const quality = all[0].scorers.find((s) => s.name === QUALITY)!;
    expect(quality.pairedCount).toBe(7);
    expect(quality.baselineMean).toBeCloseTo(0.7857, 4);
    expect(quality.candidateMean).toBeCloseTo(0.8214, 4);

    const two = build(rowsFor(1, 2)).meta.pairs[0];
    expect(two.scorers.find((s) => s.name === QUALITY)).toMatchObject({
      pairedCount: 2,
      baselineMean: 0.625,
      candidateMean: 0.625,
      delta: 0,
    });
    expect(two.scorers.find((s) => s.name === ROUTE)).toMatchObject({
      pairedCount: 2,
      transitions: { changed: 0, unchanged: 2 },
    });
    expect(two.latencyMs).toEqual({
      pairedCount: 2,
      baselineMean: 1000,
      candidateMean: 1200,
      delta: 200,
    });
    expect(two.cost).toEqual({
      pairedCount: 2,
      baselineMean: 0.01,
      candidateMean: 0.02,
      delta: 0.01,
    });
  });

  it("lists the runs whose results fall short of the cases they declared", () => {
    expect(build(model.cases).meta.truncatedRuns).toEqual([]);
    const cut: RunBundle[] = PAIRED_FIXTURE.map((b) =>
      b.run.id === CANDIDATE_RUN.id
        ? { ...b, run: { ...b.run, caseCount: 2000, resultsTruncated: true } }
        : b,
    );
    const cutModel = buildCompareModel(cut, BASELINE_RUN.id);
    const { meta } = buildComparisonExport(cutModel, {
      projectId: "p1",
      rows: cutModel.cases,
      analysis: NO_ANALYSIS,
      generatedAt: GENERATED_AT,
    });
    expect(meta.truncatedRuns).toEqual([
      { runId: "run-2", label: labelOf("run-2"), loadedResults: 11, declaredCases: 2000 },
    ]);
  });
});

describe("toCsv", () => {
  const exp = build(rowsFor(1, 6));
  const lines = toCsv(exp).split("\r\n");

  it("starts with a byte order mark and one header row naming every run's columns", () => {
    expect(toCsv(exp).startsWith("\uFEFFcase,input,expected,")).toBe(true);
    const header = lines[0].replace("\uFEFF", "").split(",");
    const baseline = labelOf("run-1");
    const candidate = labelOf("run-2");
    expect(header.slice(0, 8)).toEqual([
      "case",
      "input",
      "expected",
      `${baseline} · output`,
      `${baseline} · expected`,
      `${baseline} · status`,
      `${baseline} · latency ms`,
      `${baseline} · cost`,
    ]);
    expect(header).toContain(`${candidate} · expected`);
    expect(header).toContain(`${candidate} · quality · value`);
    expect(header).toContain(`${candidate} · quality · change`);
    expect(header).toContain(`${candidate} · quality · classification`);
    expect(header).toContain(`${candidate} · quality · not compared`);
    // 3 + 3 runs × (5 + 3 scorers × 4)
    expect(header).toHaveLength(3 + 3 * (5 + 3 * 4));
  });

  it("has one line per case, ending with a line break, and nothing else", () => {
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(lines[1].startsWith("id:case-1,Ticket 1,,run-1 output,,passed,1000,0.01,")).toBe(true);
    expect(lines[2]).toContain(",errored,1200,0.02,");
    expect(lines[2]).toContain(",Task error");
  });

  it("quotes fields with commas, quotes or line breaks, and keeps formula-like text as text", () => {
    const tricky: ComparisonExport = {
      ...exp,
      rows: [
        {
          ...exp.rows[0],
          case: "id:x",
          input: 'Say "hi", then\nleave',
          expected: "=HYPERLINK(1)",
          runs: [],
        },
      ],
    };
    const line = toCsv(tricky).split("\r\n").slice(1).join("\r\n");
    expect(line.startsWith('id:x,"Say ""hi"", then\nleave",\'=HYPERLINK(1)')).toBe(true);
  });
});

describe("toCsv — numbers and formulas", () => {
  it("writes numbers as they are, recorded as text or not, and keeps formula-like text as text", () => {
    const exp = build(rowsFor(1));
    const run = exp.rows[0].runs[1];
    const values: ComparisonExport = {
      ...exp,
      rows: [
        {
          case: "id:x",
          input: "-3",
          expected: "- refund approved",
          runs: [
            {
              ...run,
              output: "=SUM(1)",
              scores: [
                {
                  scorer: QUALITY,
                  value: "-1",
                  change: -0.25,
                  classification: "regressed",
                  notCompared: null,
                },
                {
                  scorer: POLICY,
                  value: "+1.5e-3",
                  change: -2,
                  classification: null,
                  notCompared: null,
                },
                {
                  scorer: ROUTE,
                  value: "@team",
                  change: ".5",
                  classification: null,
                  notCompared: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const fields = toCsv(values).split("\r\n")[1].split(",");
    // Text that is a number (a recorded "-3") stays as written; anything else that starts
    // like a formula gets a leading quote.
    expect(fields.slice(0, 4)).toEqual(["id:x", "-3", "'- refund approved", "'=SUM(1)"]);
    expect(fields.slice(-12)).toEqual([
      "-1",
      "-0.25",
      "regressed",
      "",
      "+1.5e-3",
      "-2",
      "",
      "",
      "'@team",
      ".5",
      "",
      "",
    ]);
    // JSON keeps every value exactly.
    expect(JSON.parse(toJson(values)).rows[0]).toMatchObject({
      input: "-3",
      expected: "- refund approved",
      runs: [
        { output: "=SUM(1)", scores: [{ value: "-1" }, { value: "+1.5e-3" }, { value: "@team" }] },
      ],
    });
  });

  it("keeps formula-like text as text behind leading whitespace or a line break", () => {
    const exp = build(rowsFor(1));
    const values: ComparisonExport = {
      ...exp,
      rows: [{ case: "id:x", input: " =SUM(1)", expected: "\n=SUM(1)", runs: [] }],
    };
    // A spreadsheet that trims a field before reading it would otherwise run these.
    const line = toCsv(values).split("\r\n")[1];
    expect(line).toBe(`id:x,' =SUM(1),"'\n=SUM(1)"`);
    // A field that starts with a tab, return or line break gets one before the text too.
    const plain: ComparisonExport = {
      ...exp,
      rows: [{ case: "id:x", input: "\tnote", expected: "\nnote", runs: [] }],
    };
    expect(toCsv(plain).split("\r\n")[1]).toBe(`id:x,'\tnote,"'\nnote"`);
  });
});

describe("toJson", () => {
  it("is the meta and rows, pretty-printed", () => {
    const exp = build(rowsFor(1));
    const text = toJson(exp);
    expect(JSON.parse(text)).toEqual(exp);
    expect(text).toContain('\n  "meta": {');
  });
});

describe("exportFileName", () => {
  it("names the baseline, the case count and the time", () => {
    expect(exportFileName(build(model.cases), "csv")).toBe(
      "comparison-1-baseline-v1-12-cases-20261111-1405.csv",
    );
    expect(exportFileName(build(rowsFor(3)), "json")).toBe(
      "comparison-1-baseline-v1-1-case-20261111-1405.json",
    );
  });
});
