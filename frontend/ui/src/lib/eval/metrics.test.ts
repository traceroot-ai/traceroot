import { describe, it, expect } from "vitest";
import { mergeScorerManifests, scorerManifestsEqual } from "./metrics";

describe("mergeScorerManifests", () => {
  it("folds the incoming manifest into the stored one by definition name (incoming wins)", () => {
    const stored = [{ name: "grade", version: "v1" }];
    const incoming = [
      { name: "grade", version: "v1", emitted_metrics: [{ name: "quality" }] },
      { name: "safety", version: "v1" },
    ];
    // grade replaced by the resolved (emitted_metrics) copy, in stored order; safety appended.
    expect(mergeScorerManifests(stored, incoming)).toEqual([
      { name: "grade", version: "v1", emitted_metrics: [{ name: "quality" }] },
      { name: "safety", version: "v1" },
    ]);
  });

  it("tolerates a null / non-array manifest and skips entries without a name", () => {
    expect(mergeScorerManifests(null, null)).toEqual([]);
    expect(mergeScorerManifests([{ version: "v1" }, 42], [{ name: "a" }])).toEqual([{ name: "a" }]);
  });
});

describe("scorerManifestsEqual", () => {
  it("is object-key-order independent, so an idempotent replay reads as equal (writes nothing)", () => {
    // jsonb reorders object keys on read-back; the merged copy uses the schema's declaration
    // order. These are the SAME manifest and must compare EQUAL.
    const a = [
      {
        name: "grade",
        emitted_metrics: [{ name: "quality", direction: "higher_is_better", threshold: 0.8 }],
      },
    ];
    const b = [
      {
        name: "grade",
        emitted_metrics: [{ threshold: 0.8, name: "quality", direction: "higher_is_better" }],
      },
    ];
    expect(scorerManifestsEqual(a, b)).toBe(true);
  });

  it("detects a genuine value difference", () => {
    expect(
      scorerManifestsEqual([{ name: "grade", version: "v1" }], [{ name: "grade", version: "v2" }]),
    ).toBe(false);
  });

  it("is array-order sensitive and handles null", () => {
    expect(
      scorerManifestsEqual([{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "a" }]),
    ).toBe(false);
    expect(scorerManifestsEqual(null, [])).toBe(false);
    expect(scorerManifestsEqual(null, null)).toBe(true);
  });
});
