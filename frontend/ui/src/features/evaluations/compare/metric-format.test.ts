import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatMetricDelta,
  formatMetricValue,
  formatMs,
  inferMetricFormat,
  signedWith,
  type MetricFormat,
} from "./metric-format";

const PROPORTION: MetricFormat = { kind: "proportion" };
const NUMBER: MetricFormat = { kind: "number" };

describe("inferMetricFormat", () => {
  it("reads a boolean column as a proportion", () => {
    expect(inferMetricFormat("boolean", [0, 1])).toEqual(PROPORTION);
  });

  it("decides a boolean column that stores other numbers from the values", () => {
    expect(inferMetricFormat("boolean", [0, 1, 3])).toEqual(NUMBER);
    expect(inferMetricFormat("boolean", [0, 0.5])).toEqual(PROPORTION);
  });

  it("reads a numeric column as a proportion only when every value is within [0,1]", () => {
    expect(inferMetricFormat("numeric", [0, 0.4, 0.85, 1])).toEqual(PROPORTION);
    expect(inferMetricFormat("numeric", [0, 0, 2])).toEqual(NUMBER);
    expect(inferMetricFormat("numeric", [-0.5, 0.5])).toEqual(NUMBER);
  });

  it("reads a column with no numeric values as a number", () => {
    expect(inferMetricFormat("numeric", [])).toEqual(NUMBER);
    expect(inferMetricFormat("categorical", [0.5])).toEqual(NUMBER);
  });
});

describe("formatMetricValue", () => {
  it("shows a proportion as a percentage", () => {
    expect(formatMetricValue(0.8214, PROPORTION)).toBe("82.1%");
    expect(formatMetricValue(0, PROPORTION)).toBe("0.0%");
  });

  it("shows a number as itself, trimmed to two decimals", () => {
    expect(formatMetricValue(2, NUMBER)).toBe("2");
    expect(formatMetricValue(0, NUMBER)).toBe("0");
    expect(formatMetricValue(0.25, NUMBER)).toBe("0.25");
    expect(formatMetricValue(4.5, NUMBER)).toBe("4.5");
    expect(formatMetricValue(1 / 3, NUMBER)).toBe("0.33");
  });
});

describe("formatMetricDelta", () => {
  it("shows a proportion change in percentage points", () => {
    expect(formatMetricDelta(0.25 / 7, PROPORTION)).toBe("+3.6 pp");
    expect(formatMetricDelta(-1, PROPORTION)).toBe("−100.0 pp");
  });

  it("shows a number change in the column's own units", () => {
    expect(formatMetricDelta(0.25, NUMBER)).toBe("+0.25");
    expect(formatMetricDelta(-2, NUMBER)).toBe("−2");
    // 4.1 - 3.1 is 0.9999999999999996 in floating point.
    expect(formatMetricDelta(4.1 - 3.1, NUMBER)).toBe("+1");
  });

  it("drops the sign when the change rounds to nothing", () => {
    expect(formatMetricDelta(0, PROPORTION)).toBe("0.0 pp");
    expect(formatMetricDelta(-0.0001, PROPORTION)).toBe("0.0 pp");
    expect(formatMetricDelta(0.001, NUMBER)).toBe("0");
  });
});

describe("formatMs", () => {
  it("reads like durations elsewhere in the app", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(840)).toBe("840ms");
    expect(formatMs(2100)).toBe("2.1s");
    expect(formatMs(65_000)).toBe("1m 5s");
  });

  it("never rounds up into the next unit's number", () => {
    expect(formatMs(999.6)).toBe("1.0s");
  });
});

describe("formatCost", () => {
  it("shows a recorded zero as $0", () => {
    expect(formatCost(0)).toBe("$0");
  });

  it("keeps two significant digits under a cent", () => {
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.000012345)).toBe("$0.000012");
  });

  it("reads cents and dollars as elsewhere in the app", () => {
    expect(formatCost(0.01)).toBe("$0.0100");
    expect(formatCost(0.0123)).toBe("$0.0123");
    expect(formatCost(12.5)).toBe("$12.50");
  });
});

describe("signedWith", () => {
  it("signs a change in the unit's own terms", () => {
    expect(signedWith(formatMs)(200)).toBe("+200ms");
    expect(signedWith(formatMs)(-1500)).toBe("−1.5s");
    expect(signedWith(formatCost)(0.01)).toBe("+$0.0100");
    expect(signedWith(formatCost)(-0.0004)).toBe("−$0.0004");
  });

  it("drops the sign when the change reads as nothing", () => {
    expect(signedWith(formatMs)(0.3)).toBe("0ms");
    // (0.1 + 0.2) / 2 - 0.15: float noise left over from subtracting two means.
    expect(signedWith(formatCost)((0.1 + 0.2) / 2 - 0.15)).toBe("$0");
  });
});
