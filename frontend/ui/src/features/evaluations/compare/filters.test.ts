import { describe, expect, it } from "vitest";
import { ANY_NAMED_FIXTURE, PAIRED_FIXTURE } from "./__tests__/paired-fixture";
import { fixtureResult } from "./__tests__/paired-fixture";
import {
  addFilter,
  clearLabel,
  clearSearchAndFilters,
  describeFilter,
  matchesSearch,
  NO_ANALYSIS,
  pruneForRuns,
  selectCases,
  sortsByRegression,
  toggleFilter,
  type CaseAnalysis,
  type CaseFilter,
  type FilterKind,
} from "./filters";
import { buildCompareModel, comparePairs, type CaseRow } from "./model";

// #1 (run-1) is the baseline; #2 (run-2) and #3 (run-3) are the candidates.
const model = buildCompareModel(PAIRED_FIXTURE, null);
const pairs = comparePairs(model);
const row = (n: number) => model.cases.find((c) => c.key === `id:case-${n}`) as CaseRow;

const filter = (kind: FilterKind, scorer: string | null = null, runId = "any"): CaseFilter => ({
  kind,
  scorer,
  runId,
});
/** The case numbers `analysis` leaves in the table, in table order. */
const picked = (analysis: Partial<CaseAnalysis>) =>
  selectCases(model, pairs, { ...NO_ANALYSIS, ...analysis }).map((c) =>
    Number(c.key.replace("id:case-", "")),
  );
const only = (...filters: CaseFilter[]) => picked({ filters });

describe("matchesSearch", () => {
  it("finds a case by any run's input, output or expected output, ignoring case", () => {
    expect(matchesSearch(row(3), "ticket 3")).toBe(true);
    expect(matchesSearch(row(3), "RUN-3 OUTPUT")).toBe(true);
    expect(matchesSearch(row(3), "ticket 4")).toBe(false);
  });

  it("finds every case for a blank search", () => {
    expect(matchesSearch(row(3), "  ")).toBe(true);
  });

  it("reads the output of a run only the case's other runs lack", () => {
    // Case 10 has no baseline result; the candidates' outputs still count.
    expect(matchesSearch(row(10), "run-2 output")).toBe(true);
    expect(matchesSearch(row(10), "run-1 output")).toBe(false);
  });

  it("finds the text decoded, not only as stored", () => {
    // Stored JSON-encoded: the quotes are escaped and the line break is "\n".
    const result = fixtureResult("run-1", "case-1", JSON.stringify("Refund policy"), [], {
      candidateOutput: JSON.stringify('She said "refund"\nthen left'),
      expectedOutput: JSON.stringify({ reply: "refund", status: "ok" }),
    });
    const [jsonRow] = buildCompareModel([{ ...PAIRED_FIXTURE[0], results: [result] }], null).cases;
    expect(matchesSearch(jsonRow, 'said "refund"')).toBe(true);
    expect(matchesSearch(jsonRow, '"reply": "refund"')).toBe(true);
    // The stored text still counts.
    expect(matchesSearch(jsonRow, '\\"refund\\"')).toBe(true);
    expect(matchesSearch(jsonRow, "refund policy")).toBe(true);
    expect(matchesSearch(jsonRow, 'said "return"')).toBe(false);
  });
});

describe("selectCases — filters", () => {
  it("picks the cases a candidate regressed or improved on for a scorer", () => {
    expect(only(filter("regressed", "quality", "run-2"))).toEqual([2]);
    expect(only(filter("improved", "quality", "run-2"))).toEqual([1, 3, 4, 5, 11, 12]);
    // A count where lower is better: more violations is the regression.
    expect(only(filter("regressed", "policy_violations", "run-2"))).toEqual([2]);
  });

  it("reads any scorer and any candidate as any of them", () => {
    // #3 scores 80% everywhere, below the baseline's 85% on every case but case 1.
    expect(only(filter("regressed", "quality"))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
    expect(only(filter("regressed", null, "run-2"))).toEqual([2]);
    expect(only(filter("improved"))).toEqual([1, 3, 4, 5, 11, 12]);
  });

  it("counts any change from the baseline as changed, with a direction or without one", () => {
    expect(only(filter("changed", "route"))).toEqual([12]);
    expect(only(filter("changed", "quality", "run-2"))).toEqual([1, 2, 3, 4, 5, 11, 12]);
    expect(only(filter("changed", "route", "run-3"))).toEqual([]);
  });

  it("picks cases with a task or scorer error", () => {
    // #2 case 6 is a task error, case 7 a quality scorer error; case 8 was never scored.
    expect(only(filter("errors"))).toEqual([6, 7]);
    expect(only(filter("errors", "quality", "run-2"))).toEqual([6, 7]);
    expect(only(filter("errors", "policy_violations", "run-2"))).toEqual([6]);
    expect(only(filter("errors", null, "run-1"))).toEqual([]);
  });

  it("picks cases some run, or the run named, has no result for", () => {
    expect(only(filter("unmatched"))).toEqual([9, 10]);
    expect(only(filter("unmatched", null, "run-1"))).toEqual([10]);
    expect(only(filter("unmatched", null, "run-2"))).toEqual([9]);
    expect(only(filter("unmatched", null, "run-3"))).toEqual([]);
  });

  it("keeps only the cases every filter picks", () => {
    expect(
      only(filter("regressed", "quality"), filter("regressed", "policy_violations", "run-2")),
    ).toEqual([2]);
    expect(only(filter("improved", "quality", "run-2"), filter("unmatched"))).toEqual([]);
  });

  it("composes with the search", () => {
    expect(picked({ q: "ticket 1", filters: [filter("improved", "quality", "run-2")] })).toEqual([
      1, 11, 12,
    ]);
  });

  it("picks nothing for a run or scorer the comparison doesn't have", () => {
    // The baseline has no change against itself.
    expect(only(filter("regressed", "quality", "run-1"))).toEqual([]);
    expect(only(filter("regressed", "quality", "run-gone"))).toEqual([]);
    expect(only(filter("errors", null, "run-gone"))).toEqual([]);
    expect(only(filter("unmatched", null, "run-gone"))).toEqual([]);
    expect(only(filter("changed", "no-such-scorer"))).toEqual([]);
  });

  it("hands back the comparison's own rows, so every run's values stay", () => {
    const [shown] = selectCases(model, pairs, {
      ...NO_ANALYSIS,
      filters: [filter("regressed", "quality", "run-2")],
    });
    expect(shown).toBe(row(2));
    expect(shown.byRun.size).toBe(3);
  });

  it("shows every case in dataset order with no search or filters", () => {
    expect(picked({})).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 10]);
  });
});

describe("selectCases — a metric named any", () => {
  const anyModel = buildCompareModel(ANY_NAMED_FIXTURE, "a");
  const anyPairs = comparePairs(anyModel);
  const count = (f: CaseFilter) =>
    selectCases(anyModel, anyPairs, { ...NO_ANALYSIS, filters: [f] }).length;

  it("filters on that metric, not on any metric", () => {
    const named: CaseFilter = { kind: "regressed", scorer: "any", runId: "b" };
    expect(count(named)).toBe(0);
    expect(count({ ...named, scorer: null })).toBe(1);
    expect(describeFilter(named, () => "#2")).toBe("Regressed · any · #2");
  });
});

describe("filter lists", () => {
  const regressed = filter("regressed", "quality", "run-2");
  const errors = filter("errors");

  it("toggles a filter on and off, keeping the others in order", () => {
    expect(toggleFilter([errors], regressed)).toEqual([errors, regressed]);
    expect(toggleFilter([regressed, errors], { ...regressed })).toEqual([errors]);
  });

  it("adds a filter once", () => {
    expect(addFilter([regressed], errors)).toEqual([regressed, errors]);
    const filters = [regressed, errors];
    expect(addFilter(filters, { ...errors })).toBe(filters);
  });
});

describe("describeFilter", () => {
  const tagOf = (runId: string) => (runId === "run-2" ? "#2" : "");

  it("names what, on which metric, for which run", () => {
    expect(describeFilter(filter("regressed", "quality", "run-2"), tagOf)).toBe(
      "Regressed · quality · #2",
    );
    expect(describeFilter(filter("errors"), tagOf)).toBe("Errors · any metric · any run");
  });

  it("leaves the metric out of an unmatched filter", () => {
    expect(describeFilter(filter("unmatched", null, "run-2"), tagOf)).toBe("Unmatched · #2");
  });

  it("says when the run is no longer compared", () => {
    expect(describeFilter(filter("improved", "quality", "run-gone"), tagOf)).toBe(
      "Improved · quality · a run not in this comparison",
    );
  });
});

describe("selectCases — regression sort", () => {
  const byRegression = (scorer: string, runId: string) => ({
    kind: "regression" as const,
    scorer,
    runId,
  });

  it("puts the worst regression first, then the rest by size, then what wasn't compared", () => {
    // #2 on quality: case 2 fell 55 points; 3, 4, 5, 11 and 12 rose 5; case 1 rose 55;
    // 6, 7 and 8 weren't compared and #2 has no case 9 nor the baseline case 10.
    expect(picked({ sort: byRegression("quality", "run-2") })).toEqual([
      2, 3, 4, 5, 11, 12, 1, 6, 7, 8, 9, 10,
    ]);
  });

  it("reads the scorer's direction, so more of a lower-is-better count is worse", () => {
    expect(picked({ sort: byRegression("policy_violations", "run-2") })).toEqual([
      2, 1, 3, 4, 5, 7, 11, 12, 6, 8, 9, 10,
    ]);
  });

  it("sorts only the cases the search and filters pick", () => {
    expect(picked({ q: "ticket 1", sort: byRegression("quality", "run-2") })).toEqual([
      11, 12, 1, 10,
    ]);
  });

  it("keeps dataset order when nothing can be compared by regression", () => {
    const datasetOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 10];
    expect(picked({ sort: byRegression("route", "run-2") })).toEqual(datasetOrder);
    expect(picked({ sort: byRegression("quality", "run-1") })).toEqual(datasetOrder);
  });

  it("only sorts a scorer with a direction by regression", () => {
    const column = (name: string) => model.scorers.find((s) => s.name === name)!;
    expect(sortsByRegression(column("quality"))).toBe(true);
    expect(sortsByRegression(column("policy_violations"))).toBe(true);
    expect(sortsByRegression(column("route"))).toBe(false);
    expect(sortsByRegression({ ...column("quality"), direction: "none" })).toBe(false);
  });
});

describe("clearing the search and filters", () => {
  const sort = { kind: "regression" as const, scorer: "quality", runId: "run-2" };

  it("takes off the search and every filter, keeping the sort", () => {
    expect(clearSearchAndFilters({ q: "refund", filters: [filter("errors")], sort })).toEqual({
      q: "",
      filters: [],
      sort,
    });
  });

  it("names what it takes off", () => {
    expect(clearLabel({ ...NO_ANALYSIS, filters: [filter("errors")] })).toBe("Clear filters");
    expect(clearLabel({ ...NO_ANALYSIS, q: "refund" })).toBe("Clear search");
    expect(clearLabel({ ...NO_ANALYSIS, q: " ", filters: [filter("errors")] })).toBe(
      "Clear filters",
    );
    expect(clearLabel({ q: "refund", filters: [filter("errors")], sort })).toBe(
      "Clear search and filters",
    );
  });
});

describe("pruneForRuns", () => {
  const byRegression = (runId: string) => ({
    kind: "regression" as const,
    scorer: "quality",
    runId,
  });
  const runs = ["run-1", "run-2", "run-3"];

  it("drops the change filters and the sort on a run that is now the baseline", () => {
    const analysis: CaseAnalysis = {
      q: "refund",
      filters: [
        filter("regressed", "quality", "run-2"),
        filter("changed", null, "run-2"),
        filter("errors", null, "run-2"),
        filter("unmatched", null, "run-2"),
        filter("improved", "quality", "run-3"),
        filter("regressed"),
      ],
      sort: byRegression("run-2"),
    };
    expect(pruneForRuns(analysis, runs, "run-2")).toEqual({
      q: "refund",
      filters: [
        filter("errors", null, "run-2"),
        filter("unmatched", null, "run-2"),
        filter("improved", "quality", "run-3"),
        filter("regressed"),
      ],
      sort: { kind: "dataset" },
    });
  });

  it("drops every filter and the sort on a run no longer compared", () => {
    const analysis: CaseAnalysis = {
      ...NO_ANALYSIS,
      filters: [filter("errors", null, "run-gone"), filter("unmatched", null, "run-gone")],
      sort: byRegression("run-gone"),
    };
    expect(pruneForRuns(analysis, runs, "run-1")).toEqual(NO_ANALYSIS);
  });

  it("hands back the same analysis when everything still applies", () => {
    const analysis: CaseAnalysis = {
      q: "",
      filters: [filter("regressed", "quality", "run-2"), filter("errors", null, "run-1")],
      sort: byRegression("run-3"),
    };
    expect(pruneForRuns(analysis, runs, "run-1")).toBe(analysis);
  });
});
