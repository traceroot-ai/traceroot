import { describe, it, expect } from "vitest";
import {
  coverageSummary,
  hasPairedCases,
  noResultsText,
  partialNotesLine,
  partialRunNotes,
} from "./coverage";
import { buildCompareModel } from "./model";
import { fixtureResult, fixtureRun } from "./__tests__/paired-fixture";

describe("coverageSummary", () => {
  it("counts all the cases, then the ones every run has", () => {
    expect(coverageSummary({ total: 12, sharedByAll: 10 })).toBe("12 cases · 10 in all runs");
    expect(coverageSummary({ total: 2, sharedByAll: 1 })).toBe("2 cases · 1 in all runs");
  });

  it("says only how many cases there are when every run has all of them", () => {
    expect(coverageSummary({ total: 12, sharedByAll: 12 })).toBe("12 cases in all runs");
  });
});

describe("partialRunNotes", () => {
  const tagOf = (runId: string) => `#${runId.replace("run-", "")}`;
  const bundle = (id: string, caseCount: number, loaded: number, resultsTruncated: boolean) => ({
    run: fixtureRun(id, 1, id, "2026-11-01T00:00:00Z", { caseCount, resultsTruncated }),
    results: Array.from({ length: loaded }, (_, i) =>
      fixtureResult(id, `case-${i}`, `Ticket ${i}`, []),
    ),
  });

  it("says a run was cut off at the most results the page loads", () => {
    expect(partialRunNotes([bundle("run-3", 1240, 1000, true)], tagOf)).toEqual([
      "#3 has 1,240 cases; this page loaded the first 1,000.",
    ]);
  });

  it("says a run reported fewer cases than it declared", () => {
    // The run read marks any run with fewer results than cases as truncated; under the
    // page's result limit, the run itself is what came up short.
    expect(partialRunNotes([bundle("run-2", 12, 11, true)], tagOf)).toEqual([
      "#2 reported 11 of 12 cases.",
    ]);
    expect(partialRunNotes([bundle("run-2", 12, 11, false)], tagOf)).toEqual([
      "#2 reported 11 of 12 cases.",
    ]);
  });

  it("says nothing about a run that reported every case it declared", () => {
    expect(partialRunNotes([bundle("run-1", 12, 12, false)], tagOf)).toEqual([]);
  });

  it("says a run has no results, whatever it declared", () => {
    expect(partialRunNotes([bundle("run-3", 12, 0, true)], tagOf)).toEqual(["#3 has no results."]);
    expect(partialRunNotes([bundle("run-3", 0, 0, false)], tagOf)).toEqual(["#3 has no results."]);
  });
});

describe("noResultsText", () => {
  it("names each run without results", () => {
    expect(noResultsText(["#3"])).toBe("#3 has no results.");
    expect(noResultsText(["#1", "#2"])).toBe("#1 and #2 have no results.");
  });
});

describe("partialNotesLine", () => {
  it("is the note itself when only one run is short", () => {
    expect(partialNotesLine([])).toBeNull();
    expect(partialNotesLine(["#2 reported 11 of 12 cases."])).toBe("#2 reported 11 of 12 cases.");
  });

  it("counts the runs when several are short", () => {
    expect(partialNotesLine(["#2 reported 11 of 12 cases.", "#3 has no results."])).toBe(
      "2 runs are missing cases",
    );
  });
});

describe("hasPairedCases", () => {
  const run = (id: string, n: number, datasetId = "ds1") =>
    fixtureRun(id, n, id, `2026-11-0${n}T00:00:00Z`, { datasetId });
  const result = (runId: string, caseId: string, input: string) =>
    fixtureResult(runId, caseId, input, []);

  it("is true when some case is in two of the runs, even if not in all of them", () => {
    const model = buildCompareModel(
      [
        { run: run("a", 1), results: [result("a", "tc-1", "x")] },
        { run: run("b", 2), results: [result("b", "tc-1", "x")] },
        { run: run("c", 3), results: [] },
      ],
      "a",
    );
    expect(model.sharedByAllCount).toBe(0);
    expect(hasPairedCases(model)).toBe(true);
  });

  it("is false when no case is in more than one run", () => {
    const model = buildCompareModel(
      [
        { run: run("a", 1), results: [result("a", "tc-1", "x")] },
        { run: run("b", 2, "ds2"), results: [result("b", "tc-9", "y")] },
      ],
      "a",
    );
    expect(hasPairedCases(model)).toBe(false);
  });
});
