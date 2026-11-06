import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The AI run overage meter reports only the delta since the last successful
// report. A failed Stripe call must keep that baseline, or the next hourly run
// re-reports units Stripe already accepted and the customer is billed twice.

const mocks = vi.hoisted(() => ({
  workspaceFindMany: vi.fn(),
  workspaceUpdate: vi.fn(),
  meterEventsCreate: vi.fn(),
  aiRunCount: vi.fn(),
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
      count: mocks.aiRunCount,
      aggregate: vi.fn().mockResolvedValue({ _sum: { cost: 0 }, _count: { id: 0 } }),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro", ENTERPRISE: "enterprise" },
  isIngestionBlocked: () => false,
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 100,
  AI_RUN_QUOTAS: { starter: { included: 100 } },
  RCA_RUN_QUOTAS: { starter: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { starter: { included: Infinity } },
  EVENT_QUOTAS: { starter: { included: 150_000 } },
}));

vi.mock("../clickhouse.js", () => ({
  getWorkspaceUsageDetails: vi.fn().mockResolvedValue({
    traces: 0,
    spans: 0,
    detectorRuns: 0,
    bySource: {
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  }),
}));

vi.mock("../usageNotifications.js", () => ({ runUsageQuotaNotifications: vi.fn() }));

import { runBillingJob } from "../usageMetering.js";

// currentUsage as the previous run saved it, fed back into the next run.
let savedUsage: unknown = null;

// Meter events Stripe accepted: recorded only when create resolves.
type MeterEvent = { event_name: string; payload: { value: string } };
const acceptedEvents: MeterEvent[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  savedUsage = null;
  acceptedEvents.length = 0;
  mocks.meterEventsCreate.mockImplementation(async (event: MeterEvent) => {
    acceptedEvents.push(event);
    return {};
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_ai_delta";
  mocks.workspaceFindMany.mockImplementation(async () => [
    {
      id: "ws-1",
      name: "Workspace",
      billingPlan: "starter",
      billingCustomerId: "cus_1",
      billingSubscriptionId: "sub_1",
      billingPeriodStart: new Date("2026-10-01T00:00:00Z"),
      billingPeriodEnd: new Date("2026-11-01T00:00:00Z"),
      ingestionBlocked: false,
      aiBlocked: false,
      rcaBlocked: false,
      detectorBlocked: false,
      currentUsage: savedUsage,
      projects: [{ id: "p1" }],
    },
  ]);
  mocks.workspaceUpdate.mockImplementation(
    async ({ data }: { data: { currentUsage: unknown } }) => {
      savedUsage = data.currentUsage;
      return {};
    },
  );
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

function acceptedAiUnits(): number {
  return acceptedEvents
    .filter((event) => event.event_name === "ai_usage")
    .reduce((sum, event) => sum + Number(event.payload.value), 0);
}

describe("AI run overage delta after a failed Stripe report", () => {
  it("does not re-report units Stripe already accepted", async () => {
    // Hour 1: 150 runs, 50 over the 100 included = 1 block = 1000 units.
    mocks.aiRunCount.mockResolvedValue(150);
    await runBillingJob();
    expect(acceptedAiUnits()).toBe(1000);

    // Hour 2: 250 runs = 2000 units, a delta of 1000, but Stripe fails.
    mocks.aiRunCount.mockResolvedValue(250);
    // Stripe rejects the create promise, as a real 503 does.
    mocks.meterEventsCreate.mockRejectedValueOnce(new Error("stripe 503"));
    await runBillingJob();
    expect(acceptedAiUnits()).toBe(1000);

    // Hour 3: Stripe is back. Only the missing 1000 units are owed.
    await runBillingJob();
    expect(acceptedAiUnits()).toBe(2000);
  });
});
