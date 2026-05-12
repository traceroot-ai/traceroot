import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@traceroot/core", () => ({
  prisma: {},
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  isAiRunBlocked: () => false,
  AI_RUN_QUOTAS: {
    free: { included: 30 },
    starter: { included: 100 },
    pro: { included: 100 },
    enterprise: { included: 0 },
  },
  EVENT_QUOTAS: {
    free: { included: 50_000 },
    starter: { included: 150_000 },
    pro: { included: 150_000 },
    enterprise: { included: 0 },
  },
}));

vi.mock("./clickhouse.js", () => ({
  getWorkspaceUsageDetails: vi.fn().mockResolvedValue({ traces: 0, spans: 0, detectorRuns: 0 }), // unused
}));

import { reportDetectorOverageToStripe } from "../usageMetering.js";

function makeStripe() {
  const create = vi.fn().mockResolvedValue({});
  return {
    client: {
      billing: {
        meterEvents: { create },
      },
    } as unknown as import("stripe").default,
    create,
  };
}

describe("reportDetectorOverageToStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a detector_usage meter event with correct units", async () => {
    const { client, create } = makeStripe();

    const ok = await reportDetectorOverageToStripe("ws-1", "cus_x", 42, client);

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0];
    expect(args.event_name).toBe("detector_usage");
    expect(args.payload.stripe_customer_id).toBe("cus_x");
    expect(args.payload.value).toBe("42");
  });

  it("skips and returns false when units <= 0 (idempotency: nothing to report)", async () => {
    const { client, create } = makeStripe();

    const a = await reportDetectorOverageToStripe("ws-1", "cus_x", 0, client);
    const b = await reportDetectorOverageToStripe("ws-1", "cus_x", -5, client);

    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns false when Stripe call throws (caller decides whether to advance lastReportedUnits)", async () => {
    const { client, create } = makeStripe();
    create.mockRejectedValueOnce(new Error("stripe down"));

    const ok = await reportDetectorOverageToStripe("ws-1", "cus_x", 100, client);

    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure-math sanity checks for the detector billing path.
// These mirror the inline math in processWorkspace so a refactor of either
// the rounding rule or the markup rate must touch this test.
// ---------------------------------------------------------------------------
describe("detector unit math (1.05× pass-through, $0.01/unit)", () => {
  function detectorUnits(systemCost: number): number {
    return Math.round(systemCost * 1.05 * 100);
  }

  it("$1.00 of system token cost → 105 units ($1.05 billed)", () => {
    expect(detectorUnits(1.0)).toBe(105);
  });

  it("$0 → 0 units", () => {
    expect(detectorUnits(0)).toBe(0);
  });

  it("very small cost rounds correctly ($0.001 → 0 units, $0.005 → 1 unit)", () => {
    expect(detectorUnits(0.001)).toBe(0);
    // 0.005 * 1.05 * 100 = 0.525 → rounds to 1
    expect(detectorUnits(0.005)).toBe(1);
  });
});

describe("detector delta tracking (idempotency contract)", () => {
  // Replicates the delta-calc shape of processWorkspace for the detector path:
  //   totalUnits = round(systemCost * 1.05 * 100)
  //   delta      = totalUnits - lastReportedUnits   (when same period)
  //   delta      = totalUnits                        (when period rolled over)
  function computeDelta(
    systemCost: number,
    lastReportedUnits: number,
    prevPeriodStart: string | null,
    currentPeriodStart: string | null,
  ): { totalUnits: number; deltaUnits: number } {
    const totalUnits = Math.round(systemCost * 1.05 * 100);
    const effectiveLast = prevPeriodStart === currentPeriodStart ? lastReportedUnits : 0;
    return { totalUnits, deltaUnits: totalUnits - effectiveLast };
  }

  it("first hour of period: full units billed", () => {
    const { deltaUnits } = computeDelta(1.0, 0, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(deltaUnits).toBe(105);
  });

  it("re-running same hour with no new cost: delta=0 (idempotent)", () => {
    const { deltaUnits } = computeDelta(1.0, 105, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(deltaUnits).toBe(0);
  });

  it("incremental cost in next hour: only delta billed", () => {
    // last hour: $1.00 → 105; new total: $1.50 → 158; delta = 53
    const { totalUnits, deltaUnits } = computeDelta(
      1.5,
      105,
      "2026-05-01T00:00:00Z",
      "2026-05-01T00:00:00Z",
    );
    expect(totalUnits).toBe(158);
    expect(deltaUnits).toBe(53);
  });

  it("billing period rollover resets the delta baseline", () => {
    const { deltaUnits } = computeDelta(0.5, 105, "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z");
    // 0.5 * 1.05 * 100 = 52.5 → 53. Period changed, baseline resets to 0.
    expect(deltaUnits).toBe(53);
  });
});

// ---------------------------------------------------------------------------
// First-100-free included threshold for paid plans. Mirrors the inline math in
// the 5d block of processWorkspace.
// ---------------------------------------------------------------------------
describe("detector included-threshold math (first 100 free on paid plans)", () => {
  const INCLUDED = 100;

  function billableUnits(systemCost: number, scansRun: number): number {
    const overageScans = Math.max(0, scansRun - INCLUDED);
    const billable = scansRun > 0 ? systemCost * (overageScans / scansRun) : 0;
    return Math.round(billable * 1.05 * 100);
  }

  it("50 scans (within 100 included): $0 billable, 0 units", () => {
    expect(billableUnits(0.05, 50)).toBe(0);
  });

  it("100 scans (exactly at threshold): $0 billable, 0 units", () => {
    expect(billableUnits(0.1, 100)).toBe(0);
  });

  it("200 scans, $0.20 total cost: half is overage → $0.10 × 1.05 = $0.105 → 11 units", () => {
    // overage proportion = 100/200 = 0.5; billable = 0.20 * 0.5 = 0.10
    // 0.10 * 1.05 * 100 = 10.5 → rounds to 11
    expect(billableUnits(0.2, 200)).toBe(11);
  });

  it("1000 scans, $1.30 total cost: 90% overage → $1.17 × 1.05 → $1.2285 → 123 units", () => {
    // overage = 900/1000 = 0.9; billable = 1.30 * 0.9 = 1.17
    // 1.17 * 1.05 * 100 = 122.85 → rounds to 123
    expect(billableUnits(1.3, 1000)).toBe(123);
  });

  it("upgrading from Free preserves the 100-free benefit: 99 scans on Starter bills $0", () => {
    // Reflects the "Starter is never worse than Free" invariant.
    expect(billableUnits(0.1, 99)).toBe(0);
  });

  it("0 scans guards against divide-by-zero", () => {
    expect(billableUnits(0, 0)).toBe(0);
  });
});
