import { describe, it, expect } from "vitest";
import {
  toRunCoverage,
  formatCoverage,
  formatCoverageRatio,
  coversFullDataset,
  isSubset,
  coverageNote,
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
    expect(coverageNote(first)).toContain("20 of 500 cases");
    expect(coverageNote(UNKNOWN_COVERAGE)).toBe("This run did not report which cases it measured.");
  });
});

describe("formatCoverage", () => {
  it("renders the four locked labels", () => {
    expect(
      formatCoverage(toRunCoverage(stored({ selectionMode: "full", selectedCaseCount: 500 }))),
    ).toBe("Full dataset · 500 cases");
    expect(formatCoverage(toRunCoverage(stored()))).toBe("Subset · 20 of 500 cases · first");
    expect(formatCoverage(toRunCoverage(stored({ selectionMode: "sample", sampleSeed: 7 })))).toBe(
      "Subset · 20 of 500 cases · sample · seed 7",
    );
    expect(formatCoverage(UNKNOWN_COVERAGE)).toBe("Coverage unknown");
  });

  it("renders an unseeded sample without a phantom seed", () => {
    expect(formatCoverage(toRunCoverage(stored({ selectionMode: "sample" })))).toBe(
      "Subset · 20 of 500 cases · sample",
    );
  });

  it("labels a first/sample run that selected every case as all cases, not a subset", () => {
    expect(formatCoverage(toRunCoverage(stored({ selectedCaseCount: 500 })))).toBe(
      "All 500 cases · first",
    );
    expect(
      formatCoverage(
        toRunCoverage(stored({ selectionMode: "sample", selectedCaseCount: 500, sampleSeed: 7 })),
      ),
    ).toBe("All 500 cases · sample · seed 7");
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
    ).toBe("Full dataset · 1 case");
  });

  it("renders the compact ratio, and a dash when nothing is known", () => {
    expect(formatCoverageRatio(toRunCoverage(stored()))).toBe("20 / 500");
    expect(formatCoverageRatio(UNKNOWN_COVERAGE)).toBe("—");
  });
});
