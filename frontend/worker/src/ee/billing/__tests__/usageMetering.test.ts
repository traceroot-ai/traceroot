import { describe, it, expect } from "vitest";

function rcaUnitsForOverage(overageRuns: number, systemTokenCost: number): number {
  if (overageRuns <= 0) return 0;
  const blocks = Math.ceil(overageRuns / 100);
  const runOverage = blocks * 1000;
  const tokenMarkup = Math.round(systemTokenCost * 1.05 * 100);
  return runOverage + tokenMarkup;
}

describe("RCA delta-tracking idempotency", () => {
  it("does not double-bill on re-run within the same billing period", () => {
    const periodStart = "2026-05-01T00:00:00.000Z";
    // First hourly run: 5 overage runs, $1.00 system cost
    const totalT1 = rcaUnitsForOverage(5, 1.0);
    const r1 = computeRcaDelta({
      totalRcaBillableUnits: totalT1,
      prevRcaPeriodStart: null,
      currentPeriodStart: periodStart,
      prevLastReportedRcaUnits: 0,
    });
    expect(r1.deltaUnits).toBe(totalT1);

    // Second hourly run: same usage (no new RCAs)
    const r2 = computeRcaDelta({
      totalRcaBillableUnits: totalT1,
      prevRcaPeriodStart: periodStart,
      currentPeriodStart: periodStart,
      prevLastReportedRcaUnits: totalT1,
    });
    expect(r2.deltaUnits).toBe(0);
  });

  it("only reports the increase since last successful report", () => {
    const periodStart = "2026-05-01T00:00:00.000Z";
    const totalT1 = rcaUnitsForOverage(5, 0);
    const totalT2 = rcaUnitsForOverage(15, 0);
    const r = computeRcaDelta({
      totalRcaBillableUnits: totalT2,
      prevRcaPeriodStart: periodStart,
      currentPeriodStart: periodStart,
      prevLastReportedRcaUnits: totalT1,
    });
    expect(r.deltaUnits).toBe(totalT2 - totalT1);
  });

  it("resets last-reported on billing-period rollover", () => {
    const r = computeRcaDelta({
      totalRcaBillableUnits: 5000,
      prevRcaPeriodStart: "2026-04-01T00:00:00.000Z",
      currentPeriodStart: "2026-05-01T00:00:00.000Z",
      prevLastReportedRcaUnits: 9999,
    });
    expect(r.lastReportedUnits).toBe(0);
    expect(r.deltaUnits).toBe(5000);
  });
});

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
