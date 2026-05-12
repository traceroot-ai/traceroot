import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { reportRcaRunOverageToStripe } from "../usageMetering.js";

function makeStripeStub(): {
  client: Stripe;
  calls: Array<Parameters<Stripe["billing"]["meterEvents"]["create"]>[0]>;
} {
  const calls: Array<Parameters<Stripe["billing"]["meterEvents"]["create"]>[0]> = [];
  const client = {
    billing: {
      meterEvents: {
        create: vi.fn(async (params: any) => {
          calls.push(params);
          return {} as any;
        }),
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

describe("reportRcaRunOverageToStripe", () => {
  it("emits a stripe meter event on the rca_usage event_name", async () => {
    const { client, calls } = makeStripeStub();
    const ok = await reportRcaRunOverageToStripe("ws-1", "cus_123", 1500, client);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].event_name).toBe("rca_usage");
    expect(calls[0].payload.stripe_customer_id).toBe("cus_123");
    expect(calls[0].payload.value).toBe("1500");
  });

  it("uses a different event_name than AI run overage (separate Stripe product)", async () => {
    const { client, calls } = makeStripeStub();
    await reportRcaRunOverageToStripe("ws-1", "cus_123", 100, client);
    expect(calls[0].event_name).not.toBe("ai_usage");
  });

  it("returns false and emits no event when units <= 0", async () => {
    const { client, calls } = makeStripeStub();
    expect(await reportRcaRunOverageToStripe("ws-1", "cus_1", 0, client)).toBe(false);
    expect(await reportRcaRunOverageToStripe("ws-1", "cus_1", -5, client)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false on stripe error and does not throw", async () => {
    const client = {
      billing: {
        meterEvents: {
          create: vi.fn().mockRejectedValue(new Error("stripe down")),
        },
      },
    } as unknown as Stripe;
    expect(await reportRcaRunOverageToStripe("ws-1", "cus_1", 100, client)).toBe(false);
  });
});

// Mirror the delta-tracking math used in processWorkspace for RCA reporting.
// This isolates the idempotency invariant from the prisma-bound flow:
//  - lastReportedUnits resets on billing-period change.
//  - Only the positive delta is reported per hourly run.
function computeRcaDelta(args: {
  totalRcaBillableUnits: number;
  prevRcaPeriodStart: string | null;
  currentPeriodStart: string | null;
  prevLastReportedRcaUnits: number;
}): { deltaUnits: number; lastReportedUnits: number } {
  const lastReportedUnits =
    args.prevRcaPeriodStart === args.currentPeriodStart ? args.prevLastReportedRcaUnits : 0;
  const deltaUnits = args.totalRcaBillableUnits - lastReportedUnits;
  return { deltaUnits, lastReportedUnits };
}

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
