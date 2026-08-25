import { describe, it, expect } from "vitest";
import { countResultStatuses, excludedSummary } from "./result-status-counts";

describe("countResultStatuses", () => {
  it("counts each emitted status independently", () => {
    expect(
      countResultStatuses([
        { status: "errored" },
        { status: "not_scored" },
        { status: "not_scored" },
      ]),
    ).toEqual({ erroredCount: 1, notScoredCount: 2 });
  });

  it("returns all zeros for no results", () => {
    expect(countResultStatuses([])).toEqual({
      erroredCount: 0,
      notScoredCount: 0,
    });
  });

  it("ignores unrecognised status strings rather than throwing", () => {
    expect(countResultStatuses([{ status: "weird" }, { status: "errored" }])).toEqual({
      erroredCount: 1,
      notScoredCount: 0,
    });
  });

  // `passed`/`failed` stay valid on the wire but no writer emits them and nothing rolls
  // them up. Pinned so a future reader does not "restore" a rollup that never had a
  // denominator.
  it("does not count the legacy pass/fail statuses", () => {
    expect(
      countResultStatuses([{ status: "passed" }, { status: "failed" }, { status: "errored" }]),
    ).toEqual({ erroredCount: 1, notScoredCount: 0 });
  });
});

describe("excludedSummary", () => {
  it("returns null when there is nothing unscorable", () => {
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
