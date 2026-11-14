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
  recoverMeterEvents: vi.fn(),
  MeterEventReconciliationError: class MeterEventReconciliationError extends Error {},
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
  recoverPendingUsageMeterEvents: mocks.recoverMeterEvents,
  MeterEventReconciliationError: mocks.MeterEventReconciliationError,
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
  mocks.recoverMeterEvents.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("billing checkpoint updates after outbox submission", () => {
  it("stores only the 500 units confirmed when total usage is 1,000", async () => {
    const operationOrder: string[] = [];
    mocks.recoverMeterEvents.mockImplementation(async () => {
      operationOrder.push("recover");
    });
    mocks.submitMeterEvent.mockImplementation(async () => {
      operationOrder.push("submit");
      return 500;
    });

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meter: "ai_usage",
        totalUnits: 1_000,
        lastReportedUnits: 0,
      }),
    );
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 500,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(workspace.currentUsage.ai?.lastReportedUnits).not.toBe(1_000);
    expect(operationOrder).toEqual(["recover", "submit"]);
  });

  it("preserves the prior checkpoint when delivery returns null", async () => {
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    mocks.submitMeterEvent.mockResolvedValue(null);

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 250,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
  });

  it("persists the workspace and preserves the checkpoint when submission throws", async () => {
    workspace.currentUsage = {
      ai: {
        lastReportedUnits: 250,
        lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
      },
    };
    workspace.ingestionBlocked = true;
    workspace.aiBlocked = true;
    mocks.submitMeterEvent.mockRejectedValue(new Error("database unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();
    expect(workspace.currentUsage.ai).toMatchObject({
      lastReportedUnits: 250,
      lastReportedPeriodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentUsage: expect.any(Object), aiBlocked: false }),
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=ai_usage, period="),
      expect.any(Error),
    );
    expect(errorLog).toHaveBeenCalledWith(
      "[Billing] Error processing workspace ws-1:",
      expect.any(AggregateError),
    );
  });

  it("isolates an expected reconciliation failure and continues another meter", async () => {
    workspace.currentUsage = {
      ai: { lastReportedUnits: 250, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
    };
    mocks.rcaCount.mockResolvedValue(101);
    mocks.submitMeterEvent.mockImplementation(async ({ meter }: { meter: string }) => {
      if (meter === "ai_usage") {
        throw new mocks.MeterEventReconciliationError("manual reconciliation required");
      }
      return 500;
    });
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledTimes(2);
    expect(workspace.currentUsage.ai).toMatchObject({ lastReportedUnits: 250 });
    expect(workspace.currentUsage.rca).toMatchObject({ lastReportedUnits: 500 });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=ai_usage, period="),
      expect.any(mocks.MeterEventReconciliationError),
    );
  });

  it("isolates an RCA exception while AI and detector checkpoints advance", async () => {
    workspace.currentUsage = {
      ai: { lastReportedUnits: 200, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
      rca: { lastReportedUnits: 300, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
      detector: { lastReportedUnits: 4, lastReportedPeriodStart: "2026-11-01T00:00:00.000Z" },
    };
    mocks.rcaCount.mockResolvedValue(101);
    mocks.usageDetails.mockResolvedValue({
      traces: 0,
      spans: 0,
      detectorRuns: 200,
      bySource: {
        user: { traces: 0, spans: 0 },
        detector: { traces: 0, spans: 0 },
        agent: { traces: 0, spans: 0 },
      },
    });
    mocks.messageAggregate.mockImplementation(
      async ({ where }: { where: { kind: string; isByok: boolean } }) => ({
        _count: { id: 0 },
        _sum: {
          inputTokens: 0,
          outputTokens: 0,
          cost: where.kind === "detector" && !where.isByok ? 0.2 : 0,
        },
      }),
    );
    mocks.submitMeterEvent.mockImplementation(async ({ meter }: { meter: string }) => {
      if (meter === "rca_usage") throw new Error("RCA outbox unavailable");
      return meter === "ai_usage" ? 500 : 11;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBillingJob();

    expect(mocks.submitMeterEvent).toHaveBeenCalledTimes(3);
    expect(workspace.currentUsage.ai).toMatchObject({ lastReportedUnits: 500 });
    expect(workspace.currentUsage.rca).toMatchObject({ lastReportedUnits: 300 });
    expect(workspace.currentUsage.detector).toMatchObject({ lastReportedUnits: 11 });
    expect(mocks.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("workspace=ws-1, meter=rca_usage, period="),
      expect.any(Error),
    );
  });
});
