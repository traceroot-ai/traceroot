import { describe, it, expect } from "vitest";
import { deriveHumanReviewSummary } from "./human-review";

describe("deriveHumanReviewSummary", () => {
  it("an unreviewed run has no active dimension and nothing pending", () => {
    const s = deriveHumanReviewSummary([
      { automatedPass: true, reviews: [] },
      { automatedPass: false, reviews: [] },
    ]);
    expect(s).toEqual({
      dimensions: [],
      reviewedCount: 0,
      pendingCount: 0,
      passCount: 0,
      failCount: 0,
      disagreementCount: 0,
    });
  });

  it("counts reviewed vs pending only for the active dimension", () => {
    // 3 results, "overall" reviewed on 1 → it's active, so the other 2 are pending.
    const s = deriveHumanReviewSummary([
      { automatedPass: true, reviews: [{ dimension: "overall", verdict: "pass" }] },
      { automatedPass: true, reviews: [] },
      { automatedPass: false, reviews: [] },
    ]);
    expect(s.dimensions).toEqual(["overall"]);
    expect(s.reviewedCount).toBe(1);
    expect(s.pendingCount).toBe(2);
    expect(s.passCount).toBe(1);
  });

  it("disagreement requires a boolean on BOTH sides; unsure and quality never coerce", () => {
    const s = deriveHumanReviewSummary([
      // human fail vs automated pass → disagreement
      { automatedPass: true, reviews: [{ dimension: "overall", verdict: "fail" }] },
      // human pass vs automated pass → agree
      { automatedPass: true, reviews: [{ dimension: "overall", verdict: "pass" }] },
      // human unsure → never a disagreement, even against a boolean automated verdict
      { automatedPass: false, reviews: [{ dimension: "overall", verdict: "unsure" }] },
      // automated has no boolean (errored/not-scored) → never a disagreement
      { automatedPass: null, reviews: [{ dimension: "overall", verdict: "fail" }] },
    ]);
    expect(s.disagreementCount).toBe(1);
    expect(s.passCount).toBe(1);
    expect(s.failCount).toBe(2);
  });

  it("sums pending across multiple active dimensions independently", () => {
    // 2 results. "overall" reviewed on both (0 pending); "safety" reviewed on 1 (1 pending).
    const s = deriveHumanReviewSummary([
      {
        automatedPass: true,
        reviews: [
          { dimension: "overall", verdict: "pass" },
          { dimension: "safety", verdict: "pass" },
        ],
      },
      { automatedPass: true, reviews: [{ dimension: "overall", verdict: "pass" }] },
    ]);
    expect(s.dimensions).toEqual(["overall", "safety"]);
    expect(s.reviewedCount).toBe(2); // both results have at least one review
    expect(s.pendingCount).toBe(1); // overall:0 + safety:1
  });
});
