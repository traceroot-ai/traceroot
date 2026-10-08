import { describe, it, expect } from "vitest";
import {
  toRunCoverage,
  formatCoverage,
  formatCoverageRatio,
  coversFullDataset,
  isSubset,
  coverageNote,
  runShortfall,
  UNKNOWN_COVERAGE,
} from "./coverage";

const stored = (over: Partial<Parameters<typeof toRunCoverage>[0]> = {}) => ({
  datasetCaseCount: 500,
  selectionMode: "first",
  selectedCaseCount: 20,
  sampleSeed: null,
  ...over,
});

describe("toRunCoverage", () => {
  it("reads the three declared modes", () => {
    expect(toRunCoverage(stored({ selectionMode: "full", selectedCaseCount: 500 }))).toEqual({
      mode: "full",
      datasetCaseCount: 500,
      selectedCaseCount: 500,
      sampleSeed: null,
    });
    expect(toRunCoverage(stored())).toEqual({
      mode: "first",
      datasetCaseCount: 500,
      selectedCaseCount: 20,
      sampleSeed: null,
    });
    expect(toRunCoverage(stored({ selectionMode: "sample", sampleSeed: 7 }))).toEqual({
      mode: "sample",
      datasetCaseCount: 500,
      selectedCaseCount: 20,
      sampleSeed: 7,
    });
  });

  it("reads a legacy row as unknown, never as full", () => {
    // The whole point: a row written before coverage existed says nothing about what
    // ran, and absence of evidence for a subset is not evidence of a full run.
    expect(
      toRunCoverage({
        datasetCaseCount: null,
        selectionMode: null,
        selectedCaseCount: null,
        sampleSeed: null,
      }),
    ).toEqual(UNKNOWN_COVERAGE);
  });

  it("degrades a half-written or unrecognised row to unknown rather than guessing", () => {
    expect(toRunCoverage(stored({ datasetCaseCount: null }))).toEqual(UNKNOWN_COVERAGE);
    expect(toRunCoverage(stored({ selectedCaseCount: null }))).toEqual(UNKNOWN_COVERAGE);
    // A mode a future writer introduced and this version cannot vouch for.
    expect(toRunCoverage(stored({ selectionMode: "stratified" }))).toEqual(UNKNOWN_COVERAGE);
  });

  it("reads a BIGINT seed back as an exact number", () => {
    // Postgres BIGINT reaches JS as a bigint, which JSON cannot serialize. A millisecond
    // timestamp is a common seed and does not fit in 32 bits.
    const c = toRunCoverage(stored({ selectionMode: "sample", sampleSeed: BigInt(1726000000000) }));
    expect(c.sampleSeed).toBe(1726000000000);
    expect(() => JSON.stringify(c)).not.toThrow();
  });

  it("drops a seed that does not belong to a sample", () => {
    expect(toRunCoverage(stored({ selectionMode: "first", sampleSeed: 7 })).sampleSeed).toBeNull();
  });
});

describe("coverage predicates", () => {
  const full = toRunCoverage(stored({ selectionMode: "full", selectedCaseCount: 500 }));
  const first = toRunCoverage(stored());
  const sample = toRunCoverage(stored({ selectionMode: "sample", sampleSeed: 7 }));

  it("treats only a proven full run as full", () => {
    expect([full, first, sample, UNKNOWN_COVERAGE].map(coversFullDataset)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("counts both deliberate subset modes as subsets, and unknown as neither", () => {
    expect([full, first, sample, UNKNOWN_COVERAGE].map(isSubset)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("does not count a first/sample run that selected every case as a subset", () => {
    expect(isSubset(toRunCoverage(stored({ selectedCaseCount: 500 })))).toBe(false);
    expect(
      isSubset(toRunCoverage(stored({ selectionMode: "sample", selectedCaseCount: 500 }))),
    ).toBe(false);
  });

  it("explains a subset, notes unknown coverage without a caveat, and stays silent on a full run", () => {
    expect(coverageNote(full)).toBeNull();
    expect(coverageNote(first)).toBe(
      "Averages here cover only these 20 cases, not the whole dataset.",
    );
    expect(coverageNote(toRunCoverage(stored({ selectedCaseCount: 1 })))).toBe(
      "Averages here cover only this 1 case, not the whole dataset.",
    );
    expect(coverageNote(UNKNOWN_COVERAGE)).toBe(
      "This run didn't report how many dataset cases it ran.",
    );
  });
});

describe("formatCoverage", () => {
  it("renders the four locked labels", () => {
    expect(
      formatCoverage(toRunCoverage(stored({ selectionMode: "full", selectedCaseCount: 500 }))),
    ).toBe("All 500 cases");
    expect(formatCoverage(toRunCoverage(stored()))).toBe("Ran 20 of 500 cases · first 20");
    expect(formatCoverage(toRunCoverage(stored({ selectionMode: "sample", sampleSeed: 7 })))).toBe(
      "Ran 20 of 500 cases · random sample (seed 7)",
    );
    expect(formatCoverage(UNKNOWN_COVERAGE)).toBe("Coverage unknown");
  });

  it("renders an unseeded sample without a phantom seed", () => {
    expect(formatCoverage(toRunCoverage(stored({ selectionMode: "sample" })))).toBe(
      "Ran 20 of 500 cases · random sample",
    );
  });

  it("labels a first/sample run that selected every case as all cases, not a subset", () => {
    expect(formatCoverage(toRunCoverage(stored({ selectedCaseCount: 500 })))).toBe("All 500 cases");
    expect(
      formatCoverage(
        toRunCoverage(stored({ selectionMode: "sample", selectedCaseCount: 500, sampleSeed: 7 })),
      ),
    ).toBe("All 500 cases");
  });

  it("pluralises the dataset size", () => {
    expect(
      formatCoverage(
        toRunCoverage({
          datasetCaseCount: 1,
          selectionMode: "full",
          selectedCaseCount: 1,
          sampleSeed: null,
        }),
      ),
    ).toBe("All 1 case");
  });

  it("renders the compact ratio, and a dash when nothing is known", () => {
    expect(formatCoverageRatio(toRunCoverage(stored()))).toBe("20 / 500");
    expect(formatCoverageRatio(UNKNOWN_COVERAGE)).toBe("—");
  });
});

describe("runShortfall", () => {
  const run = (over: Partial<Parameters<typeof runShortfall>[0]> = {}) => ({
    status: "failed",
    caseCount: 10,
    resultCount: 7,
    coverage: UNKNOWN_COVERAGE,
    ...over,
  });

  it("flags a run that stored fewer results than its declared case count", () => {
    expect(runShortfall(run())).toEqual({ reported: 7, expected: 10 });
    expect(runShortfall(run({ status: "cancelled" }))).toEqual({ reported: 7, expected: 10 });
    expect(runShortfall(run({ status: "completed" }))).toEqual({ reported: 7, expected: 10 });
  });

  it("judges a known selection against what it selected, not the run's case count", () => {
    // A --first 20 run whose caseCount is the dataset size: 20 results is complete.
    const first20 = toRunCoverage(stored());
    expect(runShortfall(run({ caseCount: 500, resultCount: 20, coverage: first20 }))).toBeNull();
    expect(runShortfall(run({ caseCount: 500, resultCount: 12, coverage: first20 }))).toEqual({
      reported: 12,
      expected: 20,
    });
  });

  it("stays silent for a complete run, a running run, and a run that declared nothing", () => {
    expect(runShortfall(run({ resultCount: 10 }))).toBeNull();
    expect(runShortfall(run({ status: "running" }))).toBeNull();
    expect(runShortfall(run({ caseCount: 0, resultCount: 0 }))).toBeNull();
  });
});
