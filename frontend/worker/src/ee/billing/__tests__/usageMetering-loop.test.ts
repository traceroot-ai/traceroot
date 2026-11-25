import { describe, it, expect, vi, beforeEach } from "vitest";

// Drives runBillingJob → processWorkspace with all IO mocked, to pin the Loop
// meter: runs counted from the sessions of Loop turns, written to currentUsage.loop (the billing
// tab's Loop usage card), loopBlocked set and cleared like detectorBlocked, and
// hosted Loop inference reported to Stripe by the detector rule.

const mocks = vi.hoisted(() => ({
  workspaceFindMany: vi.fn(),
  workspaceUpdate: vi.fn(),
  loopRunSessions: vi.fn(),
  aIMessageAggregate: vi.fn(),
  getWorkspaceUsageDetails: vi.fn(),
  meterEventsCreate: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    subscriptions = { retrieve: async () => ({ items: { data: [] } }) };
    subscriptionItems = { update: async () => ({}) };
    billing = { meterEvents: { create: (...a: unknown[]) => mocks.meterEventsCreate(...a) } };
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findMany: mocks.workspaceFindMany, update: mocks.workspaceUpdate },
    detectorRca: { count: vi.fn().mockResolvedValue(0) },
    aIMessage: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: mocks.aIMessageAggregate,
      // The run count groups Loop turns by session; the per-model breakdowns are empty.
      groupBy: vi.fn(async ({ by }: { by: string[] }) =>
        by.includes("sessionId") ? mocks.loopRunSessions() : [],
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  isIngestionBlocked: () => false,
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  isLoopRunBlocked: (plan: string, runs: number) => plan === "free" && runs >= 30,
  findPlanItem: () => undefined,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 100,
  LOOP_HOSTED_LLM_FREE_THRESHOLD: 30,
  AI_RUN_QUOTAS: { free: { included: 30 }, pro: { included: 100 } },
  RCA_RUN_QUOTAS: { free: { included: 30 }, pro: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { free: { included: 100 }, pro: { included: Infinity } },
  LOOP_RUN_QUOTAS: { free: { included: 30 }, pro: { included: Infinity } },
  EVENT_QUOTAS: { free: { included: 50_000 }, pro: { included: 150_000 } },
}));

vi.mock("../clickhouse.js", () => ({ getWorkspaceUsageDetails: mocks.getWorkspaceUsageDetails }));
vi.mock("../usageNotifications.js", () => ({ runUsageQuotaNotifications: vi.fn() }));

import { prisma } from "@traceroot/core";
import { runBillingJob } from "../usageMetering.js";

/** The aIMessage groupBy by session: one row per run that called the agent. */
const runSessions = (runs: number) =>
  Array.from({ length: runs }, (_, i) => ({ sessionId: `session-${i}` }));

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    name: "Acme",
    billingPlan: "free",
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    loopBlocked: false,
    currentUsage: null,
    projects: [{ id: "proj-1", deleteTime: null, freeQuotaEligible: true }],
    ...overrides,
  };
}

const written = () => mocks.workspaceUpdate.mock.calls[0]![0].data;

/** Hosted and BYOK cost of the period's Loop turns, as the aIMessage aggregate returns it. */
let loopCost = { system: 0.25, byok: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loopRunSessions.mockReturnValue([]);
  delete process.env.STRIPE_SECRET_KEY;
  loopCost = { system: 0.25, byok: 0 };
  mocks.workspaceUpdate.mockResolvedValue({});
  mocks.meterEventsCreate.mockResolvedValue({});
  mocks.aIMessageAggregate.mockImplementation(async ({ where }) =>
    where.kind === "loop"
      ? {
          _count: { id: 2 },
          _sum: {
            inputTokens: 1000,
            outputTokens: 200,
            cost: where.isByok ? loopCost.byok : loopCost.system,
          },
        }
      : { _count: { id: 0 }, _sum: {} },
  );
  mocks.getWorkspaceUsageDetails.mockResolvedValue({
    traces: 0,
    spans: 0,
    detectorRuns: 0,
    bySource: {
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  });
});

describe("Loop metering", () => {
  it("counts the workspace's counted loop runs into currentUsage.loop", async () => {
    mocks.workspaceFindMany.mockResolvedValue([workspace()]);
    mocks.loopRunSessions.mockReturnValue(runSessions(12));

    await runBillingJob();

    const groupBy = vi.mocked(prisma.aIMessage.groupBy).mock.calls.map(([query]) => query);
    const sessions = groupBy.find((query) => query.by.includes("sessionId"))!;
    // One session per run that called the agent: its Loop turn, which outlives the Loop.
    expect(sessions.by).toEqual(["sessionId"]);
    expect(sessions.where).toMatchObject({
      workspaceId: "ws-1",
      kind: "loop",
      sessionId: { not: null },
    });
    expect(written().currentUsage.loop).toMatchObject({
      runsUsed: 12,
      systemTokenCost: 0.25,
      systemInputTokens: 1000,
      systemOutputTokens: 200,
    });
    expect(written().loopBlocked).toBeUndefined(); // unchanged
  });

  it("breaks the Loop and detector cost down by model, naming a missing model unknown", async () => {
    mocks.workspaceFindMany.mockResolvedValue([workspace()]);
    const rows = [
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        isByok: false,
        _count: { id: 3 },
        _sum: { inputTokens: 900, outputTokens: 90, cost: 0.2 },
      },
      // A row whose fields Postgres left empty.
      { model: null, provider: null, isByok: null, _count: { id: 1 }, _sum: {} },
    ];
    const groupBy = vi.mocked(prisma.aIMessage.groupBy);
    const sessionsOnly = groupBy.getMockImplementation()!;
    groupBy.mockImplementation((async ({
      by,
      where,
    }: {
      by: string[];
      where: { kind: string; isByok: boolean };
    }) => (by.includes("sessionId") || where.isByok ? [] : rows)) as never);
    try {
      await runBillingJob();
    } finally {
      groupBy.mockImplementation(sessionsOnly);
    }

    const expected = [
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        isByok: false,
        messages: 3,
        inputTokens: 900,
        outputTokens: 90,
        cost: 0.2,
      },
      {
        model: "unknown",
        provider: "unknown",
        isByok: false,
        messages: 1,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      },
    ];
    expect(written().currentUsage.loop.byModel).toEqual(expected);
    expect(written().currentUsage.detector.byModel).toEqual(expected);
  });

  it("blocks a Free workspace at its cap", async () => {
    mocks.workspaceFindMany.mockResolvedValue([workspace()]);
    mocks.loopRunSessions.mockReturnValue(runSessions(30));

    await runBillingJob();

    expect(written().loopBlocked).toBe(true);
  });

  it("unblocks a Free workspace back under its cap", async () => {
    mocks.workspaceFindMany.mockResolvedValue([workspace({ loopBlocked: true })]);
    mocks.loopRunSessions.mockReturnValue(runSessions(3));

    await runBillingJob();

    expect(written().loopBlocked).toBe(false);
  });

  it("clears the flag on a paid plan, whatever the count", async () => {
    mocks.workspaceFindMany.mockResolvedValue([
      workspace({ billingPlan: "pro", loopBlocked: true }),
    ]);
    mocks.loopRunSessions.mockReturnValue(runSessions(500));

    await runBillingJob();

    expect(written().loopBlocked).toBe(false);
    expect(written().currentUsage.loop.runsUsed).toBe(500);
  });

  it("keeps the previous Loop numbers and flag when the Loop meter fails", async () => {
    const previous = {
      runsUsed: 9,
      systemTokenCost: 0,
      systemInputTokens: 0,
      systemOutputTokens: 0,
    };
    mocks.workspaceFindMany.mockResolvedValue([
      workspace({ loopBlocked: true, currentUsage: { loop: previous } }),
    ]);
    mocks.loopRunSessions.mockRejectedValue(new Error("db down"));

    await runBillingJob();

    expect(written().currentUsage.loop).toEqual(previous);
    expect(written().loopBlocked).toBeUndefined();
    expect(written().currentUsage.detector).toBeDefined();
  });
});

describe("Loop hosted inference on paid plans", () => {
  // The previous run's currentUsage, fed back into the next run.
  let saved: unknown;

  beforeEach(() => {
    saved = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_loop";
    mocks.workspaceFindMany.mockImplementation(async () => [
      workspace({
        billingPlan: "pro",
        billingCustomerId: "cus_1",
        billingSubscriptionId: "sub_1",
        billingPeriodStart: new Date("2026-11-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-12-01T00:00:00Z"),
        currentUsage: saved,
      }),
    ]);
    mocks.workspaceUpdate.mockImplementation(async ({ data }) => {
      saved = data.currentUsage;
      return {};
    });
  });

  const loopEvents = () =>
    mocks.meterEventsCreate.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_name === "detector_usage");

  it("bills the hosted cost past the first 30 runs at 1.05x, on the detector meter, once", async () => {
    mocks.loopRunSessions.mockReturnValue(runSessions(40));
    loopCost = { system: 1.0, byok: 5.0 };

    await runBillingJob();

    // $1.00 x 10/40 overage runs x 1.05 = $0.2625 = 26 units; the BYOK $5 is never billed.
    expect(loopEvents()).toHaveLength(1);
    expect(loopEvents()[0]).toMatchObject({
      event_name: "detector_usage",
      payload: { stripe_customer_id: "cus_1", value: "26" },
    });
    expect(saved).toMatchObject({
      loop: { lastReportedUnits: 26, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
    });

    // The next hour, nothing new: nothing reported again.
    await runBillingJob();
    expect(loopEvents()).toHaveLength(1);

    // More runs: 50 runs, $2.00 x 20/50 x 1.05 = 84 units in all, of which 58 are new.
    mocks.loopRunSessions.mockReturnValue(runSessions(50));
    loopCost = { system: 2.0, byok: 0 };
    await runBillingJob();
    expect(loopEvents().map((event) => event.payload.value)).toEqual(["26", "58"]);
  });

  it("bills nothing within the first 30 runs", async () => {
    mocks.loopRunSessions.mockReturnValue(runSessions(30));
    loopCost = { system: 3.0, byok: 0 };

    await runBillingJob();

    expect(loopEvents()).toEqual([]);
  });

  it("keeps the baseline when Stripe refuses the report, and retries the delta", async () => {
    mocks.loopRunSessions.mockReturnValue(runSessions(40));
    loopCost = { system: 1.0, byok: 0 };
    mocks.meterEventsCreate.mockRejectedValueOnce(new Error("stripe 503"));

    await runBillingJob();
    expect(saved).toMatchObject({ loop: { lastReportedUnits: 0 } });

    await runBillingJob();
    expect(loopEvents().at(-1)).toMatchObject({ payload: { value: "26" } });
    expect(saved).toMatchObject({ loop: { lastReportedUnits: 26 } });
  });
});
