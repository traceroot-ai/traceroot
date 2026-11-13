import { describe, it, expect } from "vitest";

function rcaUnitsForOverage(overageRuns: number, systemTokenCost: number): number {
  if (overageRuns <= 0) return 0;
  const blocks = Math.ceil(overageRuns / 100);
  const runOverage = blocks * 1000;
  const tokenMarkup = Math.round(systemTokenCost * 1.05 * 100);
  return runOverage + tokenMarkup;
}

describe("RCA unit math", () => {
  it("100 overage runs = 1 block = 1000 units (run overage portion)", () => {
    expect(rcaUnitsForOverage(100, 0)).toBe(1000);
  });

  it("105 overage runs = 2 blocks = 2000 units", () => {
    expect(rcaUnitsForOverage(105, 0)).toBe(2000);
  });

  it("token markup is 1.05x systemTokenCost in cent units", () => {
    // $2.00 cost * 1.05 * 100 cents = 210 units
    expect(rcaUnitsForOverage(0, 2.0)).toBe(0); // no overage runs => no markup either (gated by caller)
    // Combined: 5 overage runs ($10 fee = 1000 units) + $2 token markup (210 units) = 1210
    expect(rcaUnitsForOverage(5, 2.0)).toBe(1210);
  });
});
