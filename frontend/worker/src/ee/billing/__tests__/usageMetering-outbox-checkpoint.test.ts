import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findManyWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  messageCount: vi.fn(),
  messageAggregate: vi.fn(),
  messageGroupBy: vi.fn(),
  messagesForCost: vi.fn(),
  rcaCount: vi.fn(),
  usageDetails: vi.fn(),
  submitMeterEvent: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: {
      findMany: mocks.findManyWorkspaces,
      update: mocks.updateWorkspace,
    },
    detectorRca: { count: mocks.rcaCount },
    aIMessage: {
      count: mocks.messageCount,
      aggregate: mocks.messageAggregate,
      groupBy: mocks.messageGroupBy,
      findMany: mocks.messagesForCost,
    },
  },
  USAGE_CONFIG: { includedUnits: 50_000 },
  PlanType: {
    FREE: "free",
    STARTER: "starter",
    PRO: "pro",
    ENTERPRISE: "enterprise",
  },
  isAiRunBlocked: () => false,
  isRcaRunBlocked: () => false,
  isDetectorRunBlocked: () => false,
  isIngestionBlocked: () => false,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD: 100,
  AI_RUN_QUOTAS: { pro: { included: 100 } },
  RCA_RUN_QUOTAS: { pro: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { pro: { included: 100 } },
  EVENT_QUOTAS: { pro: { included: 150_000 } },
  findPlanItem: () => ({ id: "si_123", quantity: 3 }),
}));

vi.mock("../clickhouse.js", () => ({
  getWorkspaceUsageDetails: mocks.usageDetails,
}));
vi.mock("../usageNotifications.js", () => ({
  runUsageQuotaNotifications: vi.fn(),
}));
vi.mock("../meterEventOutbox.js", () => ({
  submitUsageMeterEvent: mocks.submitMeterEvent,
}));
vi.mock("stripe", () => ({
  default: class StripeMock {
    subscriptions = {
      retrieve: vi.fn().mockResolvedValue({ items: { data: [] } }),
    };
    subscriptionItems = { update: vi.fn() };
    billing = { meterEvents: { create: vi.fn() } };
  },
}));

import { runBillingJob } from "../usageMetering.js";

interface MeterCheckpoint {
  lastReportedUnits?: number;
  lastReportedPeriodStart?: string | null;
}

interface UsageSnapshot {
  ai?: MeterCheckpoint;
  rca?: MeterCheckpoint;
  detector?: MeterCheckpoint;
  [key: string]: unknown;
}

function makeWorkspace() {
  return {
    id: "ws-1",
    name: "Acme",
    billingPlan: "pro",
    billingCustomerId: "cus_123",
    billingSubscriptionId: "sub_123",
    billingPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    billingPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
    ingestionBlocked: false,
    aiBlocked: false,
    rcaBlocked: false,
    detectorBlocked: false,
    currentUsage: {} as UsageSnapshot,
    projects: [{ id: "project-1", deleteTime: null, freeQuotaEligible: true }],
  };
}

let workspace: ReturnType<typeof makeWorkspace>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_mock");
  workspace = makeWorkspace();
  mocks.findManyWorkspaces.mockImplementation(async () => [structuredClone(workspace)]);
  mocks.updateWorkspace.mockImplementation(async ({ data }) => {
    workspace = { ...workspace, ...data };
  });
  mocks.messageCount.mockImplementation(async ({ where }: { where: { kind: string } }) =>
    where.kind === "chat" ? 101 : 0,
  );
  mocks.messageAggregate.mockResolvedValue({
    _count: { id: 0 },
    _sum: { inputTokens: 0, outputTokens: 0, cost: 0 },
  });
  mocks.messageGroupBy.mockResolvedValue([]);
  mocks.messagesForCost.mockResolvedValue([]);
  mocks.rcaCount.mockResolvedValue(0);
  mocks.usageDetails.mockResolvedValue({
    traces: 0,
    spans: 0,
    detectorRuns: 0,
    bySource: {
      user: { traces: 0, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  });
  mocks.submitMeterEvent.mockResolvedValue(1_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("billing checkpoint updates after outbox submission", () => {
  it("advances the AI checkpoint only to the cumulative units confirmed by the outbox", async () => {
    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meter: "ai_usage",
        totalUnits: 1_000,
        lastReportedUnits: 0,
      }),
    );
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 1_000,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
  });

  it("preserves the checkpoint when delivery is not confirmed, then skips an already-reported delta", async () => {
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    mocks.submitMeterEvent.mockResolvedValueOnce(null).mockResolvedValue(1_000);

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 250,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 1_000,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(mocks.submitMeterEvent).toHaveBeenCalledTimes(2);
  });
});
