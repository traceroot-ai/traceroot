import { describe, it, expect } from "vitest";
import { countResultStatuses, passRate, excludedSummary } from "./pass-rate";

describe("countResultStatuses", () => {
  it("counts each status independently", () => {
    expect(
      countResultStatuses([
        { status: "passed" },
        { status: "passed" },
        { status: "failed" },
        { status: "errored" },
        { status: "not_scored" },
      ]),
    ).toEqual({ passedCount: 2, failedCount: 1, erroredCount: 1, notScoredCount: 1 });
  });

  it("returns all zeros for no results", () => {
    expect(countResultStatuses([])).toEqual({
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      notScoredCount: 0,
    });
  });

  it("ignores unrecognised status strings rather than throwing", () => {
    expect(countResultStatuses([{ status: "weird" }, { status: "passed" }])).toEqual({
      passedCount: 1,
      failedCount: 0,
      erroredCount: 0,
      notScoredCount: 0,
    });
  });
});

describe("passRate", () => {
  it("divides passed by passed + failed", () => {
    // Exact, not toBeCloseTo: a loose tolerance would also accept a subtly wrong formula.
    expect(passRate(18, 4)).toBe(18 / 22);
  });

  // The load-bearing rule: an all-errored run must not read as a 0% quality collapse.
  it("returns null when nothing was judged", () => {
    expect(passRate(0, 0)).toBeNull();
  });

  it("returns 0 when cases were judged and all failed", () => {
    expect(passRate(0, 5)).toBe(0);
  });

  it("returns 1 when every judged case passed", () => {
    expect(passRate(5, 0)).toBe(1);
  });
});

describe("excludedSummary", () => {
  it("returns null when nothing was excluded", () => {
    expect(excludedSummary(0, 0)).toBeNull();
  });

  it("names both kinds when both are present", () => {
    expect(excludedSummary(2, 1)).toBe("2 errored, 1 not scored");
  });

  it("omits a zero side", () => {
    expect(excludedSummary(0, 3)).toBe("3 not scored");
    expect(excludedSummary(4, 0)).toBe("4 errored");
  });
});
