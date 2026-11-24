import { describe, expect, it } from "vitest";
import type { ScorerColumn } from "./model";
import { formatScore } from "./score-cell";

const column = (valueType: ScorerColumn["valueType"]): ScorerColumn => ({
  name: "tier",
  valueType,
  direction: valueType === "categorical" ? "none" : "higher_is_better",
  format: { kind: "number" },
});

describe("formatScore", () => {
  it("rounds a number in a numeric column to the column's format", () => {
    expect(formatScore(0.125, column("numeric"))).toBe("0.13");
  });

  it("shows a categorical column's values as recorded, numbers included", () => {
    expect(formatScore(0.125, column("categorical"))).toBe("0.125");
    expect(formatScore(true, column("categorical"))).toBe("true");
    expect(formatScore("gold", column("categorical"))).toBe("gold");
  });
});
