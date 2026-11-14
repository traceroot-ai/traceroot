import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

interface BillingTestOutboxEvent {
  id: string;
  workspaceId: string;
  meter: string;
  periodStart: Date;
  cumulativeUnits: number;
  eventName: string;
  identifier: string;
  customerId: string;
  units: number;
  eventTimestamp: Date;
  status: string;
  attemptCount: number;
  firstAttemptAt: Date | null;
  ambiguousSince: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  submittedAt: Date | null;
  createTime: Date;
  updateTime: Date;
}

const billingMocks = vi.hoisted(() => {
  const mocks = {
    findManyWorkspaces: vi.fn(),
    updateWorkspace: vi.fn(),
    messageCount: vi.fn(),
    messageAggregate: vi.fn(),
    messageGroupBy: vi.fn(),
    messagesForCost: vi.fn(),
    rcaCount: vi.fn(),
    usageDetails: vi.fn(),
    events: [] as BillingTestOutboxEvent[],
    stripeMeterEventCreate: vi.fn(),
    eventSequence: 0,
    statuses: {
      PENDING: "PENDING",
      SUBMITTED: "SUBMITTED",
      RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
    },
  };

  function matchesEvent(event: BillingTestOutboxEvent, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") {
        return (expected as Record<string, unknown>[]).some((condition) =>
          matchesEvent(event, condition),
        );
      }
      if (
        key === "status" &&
        typeof expected === "object" &&
        expected !== null &&
        "in" in expected
      ) {
        return (expected as { in: string[] }).in.includes(event.status);
      }
      if (key === "periodStart" && expected instanceof Date) {
        return event.periodStart.getTime() === expected.getTime();
      }
      if (
        key === "claimedAt" &&
        typeof expected === "object" &&
        expected !== null &&
        "lte" in expected
      ) {
        return event.claimedAt !== null && event.claimedAt <= (expected as { lte: Date }).lte;
      }
      return event[key as keyof BillingTestOutboxEvent] === expected;
    });
  }

  const stripeMeterEventDelegate = {
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return structuredClone(mocks.events.find((event) => matchesEvent(event, where)) ?? null);
    },
    async findMany() {
      return [];
    },
    async findUnique({ where }: { where: Record<string, unknown> }) {
      return structuredClone(mocks.events.find((event) => matchesEvent(event, where)) ?? null);
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const now = new Date();
      const event: BillingTestOutboxEvent = {
        ...(data as Omit<
          BillingTestOutboxEvent,
          | "id"
          | "status"
          | "attemptCount"
          | "firstAttemptAt"
          | "ambiguousSince"
          | "lastAttemptAt"
          | "lastErrorCode"
          | "claimToken"
          | "claimedAt"
          | "submittedAt"
          | "createTime"
          | "updateTime"
        >),
        id: `outbox-${++mocks.eventSequence}`,
        status: mocks.statuses.PENDING,
        attemptCount: 0,
        firstAttemptAt: null,
        ambiguousSince: null,
        lastAttemptAt: null,
        lastErrorCode: null,
        claimToken: null,
        claimedAt: null,
        submittedAt: null,
        createTime: now,
        updateTime: now,
      };
      mocks.events.push(event);
      return structuredClone(event);
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const event = mocks.events.find((candidate) => matchesEvent(candidate, where));
      if (!event) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (
          key === "attemptCount" &&
          typeof value === "object" &&
          value !== null &&
          "increment" in value
        ) {
          event.attemptCount += (value as { increment: number }).increment;
        } else {
          (event as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return { count: 1 };
    },
  };

  return { ...mocks, stripeMeterEventDelegate };
});

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findMany: billingMocks.findManyWorkspaces,
      update: billingMocks.updateWorkspace,
    },
    detectorRca: { count: billingMocks.rcaCount },
    aIMessage: {
      count: billingMocks.messageCount,
      aggregate: billingMocks.messageAggregate,
      groupBy: billingMocks.messageGroupBy,
      findMany: billingMocks.messagesForCost,
    },
    stripeMeterEvent: billingMocks.stripeMeterEventDelegate,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: async () => 1,
        stripeMeterEvent: billingMocks.stripeMeterEventDelegate,
      }),
  },
  StripeMeterEventStatus: billingMocks.statuses,
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  isIngestionBlocked: () => false,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 100,
  AI_RUN_QUOTAS: { pro: { included: 100 } },
  RCA_RUN_QUOTAS: { pro: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { pro: { included: 100 } },
  EVENT_QUOTAS: { pro: { included: 150_000 } },
  findPlanItem: () => ({ id: "si_plan", quantity: 3 }),
}));

vi.mock("../clickhouse.js", () => ({
  getWorkspaceUsageDetails: billingMocks.usageDetails,
}));
vi.mock("../usageNotifications.js", () => ({
  runUsageQuotaNotifications: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class StripeMock {
    subscriptions = {
      retrieve: vi.fn().mockResolvedValue({ items: { data: [] } }),
    };
    subscriptionItems = { update: vi.fn() };
    billing = { meterEvents: { create: billingMocks.stripeMeterEventCreate } };
  },
}));

import { runBillingJob } from "../usageMetering.js";

const periodStart = new Date("2026-11-01T00:00:00.000Z");
let billingWorkspace: {
  id: string;
  name: string;
  billingPlan: string;
  billingCustomerId: string;
  billingSubscriptionId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  ingestionBlocked: boolean;
  aiBlocked: boolean;
  rcaBlocked: boolean;
  detectorBlocked: boolean;
  currentUsage: { detector: { lastReportedUnits: number; lastReportedPeriodStart: string } };
  projects: { id: string; deleteTime: null; freeQuotaEligible: boolean }[];
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_mock");
  billingMocks.events.length = 0;
  billingMocks.eventSequence = 0;
  billingWorkspace = {
    id: "ws-detector",
    name: "Detector workspace",
    billingPlan: "pro",
    billingCustomerId: "cus_detector",
    billingSubscriptionId: "sub_detector",
    billingPeriodStart: periodStart,
    billingPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
    ingestionBlocked: false,
    aiBlocked: false,
    rcaBlocked: false,
    detectorBlocked: false,
    currentUsage: {
      detector: { lastReportedUnits: 5, lastReportedPeriodStart: periodStart.toISOString() },
    },
    projects: [{ id: "project-detector", deleteTime: null, freeQuotaEligible: true }],
  };
  billingMocks.findManyWorkspaces.mockImplementation(async () => [
    structuredClone(billingWorkspace),
  ]);
  billingMocks.updateWorkspace.mockImplementation(async ({ data }) => {
    billingWorkspace = { ...billingWorkspace, ...data };
  });
  billingMocks.messageCount.mockImplementation(async ({ where }: { where: { kind: string } }) =>
    where.kind === "chat" ? 101 : 0,
  );
  billingMocks.messageAggregate.mockImplementation(
    async ({ where }: { where: { kind: string; isByok: boolean } }) => ({
      _count: { id: 0 },
      _sum: {
        inputTokens: 0,
        outputTokens: 0,
        cost: where.kind === "detector" && !where.isByok ? 0.2 : 0,
      },
    }),
  );
  billingMocks.messageGroupBy.mockResolvedValue([]);
  billingMocks.messagesForCost.mockResolvedValue([]);
  billingMocks.rcaCount.mockResolvedValue(0);
  billingMocks.usageDetails.mockResolvedValue({
    traces: 0,
    spans: 0,
    detectorRuns: 200,
    bySource: {
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  });
  billingMocks.stripeMeterEventCreate.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("counts failed scans that used inference in the denominator: 100 completed + 50 failed-billed = 150", () => {
    // scansRun is the canonical ClickHouse count of runs whose latest version
    // completed OR recorded inference usage — a failed run that burned model
    // calls is one scan. Before the fix this read as 100 scans (no overage);
    // now 50 of 150 scans are billable.
    // billable = 0.30 * (50/150) = 0.10 → 0.10 * 1.05 * 100 = 10.5 → 11
    expect(billableUnits(0.3, 150)).toBe(11);
  });

  it("upgrading from Free preserves the 100-free benefit: 99 scans on Starter bills $0", () => {
    // Reflects the "Starter is never worse than Free" invariant.
    expect(billableUnits(0.1, 99)).toBe(0);
  });

  it("0 scans guards against divide-by-zero", () => {
    expect(billableUnits(0, 0)).toBe(0);
  });
});

describe("detector billing-job outbox integration", () => {
  it("calculates and confirms only the detector delta with the detector meter and customer", async () => {
    await runBillingJob();

    expect(billingMocks.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "ws-detector",
        customerId: "cus_detector",
        meter: "detector_usage",
        periodStart,
        cumulativeUnits: 11,
        units: 6,
        status: "SUBMITTED",
      }),
    );
    expect(billingMocks.stripeMeterEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "detector_usage",
        payload: { stripe_customer_id: "cus_detector", value: "6" },
      }),
    );
    expect(billingWorkspace.currentUsage.detector).toMatchObject({
      lastReportedUnits: 11,
      lastReportedPeriodStart: periodStart.toISOString(),
    });
  });

  it("does not advance detector checkpoint when the submission is ambiguous", async () => {
    billingMocks.stripeMeterEventCreate.mockImplementation(async ({ event_name }) => {
      if (event_name === "detector_usage") throw new Error("request timed out");
      return {};
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();

    expect(billingWorkspace.currentUsage.detector).toMatchObject({
      lastReportedUnits: 5,
      lastReportedPeriodStart: periodStart.toISOString(),
    });
    expect(billingMocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(billingMocks.events).toContainEqual(
      expect.objectContaining({ meter: "detector_usage", status: "PENDING" }),
    );
  });
});
