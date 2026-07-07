import { describe, expect, it } from "vitest";
import { RANGE_PRESETS, makeRange } from "./range-presets";

describe("makeRange", () => {
  it("spans exactly the requested number of days, ending now", () => {
    const before = Date.now();
    const r = makeRange(7);
    const after = Date.now();
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 86_400_000);
    expect(r.end.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.end.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("RANGE_PRESETS", () => {
  it("offers the dashboard's three presets", () => {
    expect(RANGE_PRESETS.map((p) => p.days)).toEqual([1, 7, 30]);
  });
});
