import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The public demo workspace (DEMO_WORKSPACE_ID) is not filtered out of the
// billing job. It is set to the enterprise plan with no Stripe subscription,
// and this test pins why that is enough: with Stripe configured, the job still
// makes no Stripe call and sends no usage email for it.

const mocks = vi.hoisted(() => ({
  workspaceFindMany: vi.fn(),
  workspaceUpdate: vi.fn(),
  runUsageQuotaNotifications: vi.fn(),
  stripeCalls: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    subscriptions = { retrieve: (...a: unknown[]) => mocks.stripeCalls("subscriptions", ...a) };
    subscriptionItems = {
      update: (...a: unknown[]) => mocks.stripeCalls("subscriptionItems", ...a),
    };
    billing = {
      meterEvents: { create: (...a: unknown[]) => mocks.stripeCalls("meterEvents", ...a) },
    };
  },
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findMany: mocks.workspaceFindMany, update: mocks.workspaceUpdate },
    detectorRca: { count: vi.fn().mockResolvedValue(500) },
    aIMessage: {
      count: vi.fn().mockResolvedValue(500),
      aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { id: 0 } }),
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
  AI_RUN_QUOTAS: { enterprise: { included: Infinity } },
  RCA_RUN_QUOTAS: { enterprise: { included: Infinity } },
  DETECTOR_RUN_QUOTAS: { enterprise: { included: Infinity } },
  EVENT_QUOTAS: { enterprise: { included: Infinity } },
}));

vi.mock("../clickhouse.js", () => ({
  // A busy month: far above the free event cap.
  getWorkspaceUsageDetails: vi.fn().mockResolvedValue({
    traces: 12_000,
    spans: 110_000,
    detectorRuns: 4_000,
    bySource: {
      user: { traces: 12_000, spans: 110_000 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  }),
}));

vi.mock("../usageNotifications.js", () => ({
  runUsageQuotaNotifications: mocks.runUsageQuotaNotifications,
}));

import { runBillingJob } from "../usageMetering.js";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_demo";
  mocks.workspaceUpdate.mockResolvedValue({});
  mocks.workspaceFindMany.mockResolvedValue([
    {
      id: "ws-demo",
      name: "TraceRoot Demo",
      billingPlan: "enterprise",
      billingCustomerId: null,
      billingSubscriptionId: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      ingestionBlocked: false,
      aiBlocked: false,
      rcaBlocked: false,
      detectorBlocked: false,
      currentUsage: null,
      projects: [{ id: "proj-demo" }],
    },
  ]);
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

describe("runBillingJob and the demo workspace", () => {
  it("makes no Stripe call and sends no usage email for an enterprise workspace without a subscription", async () => {
    await runBillingJob();

    expect(mocks.stripeCalls).not.toHaveBeenCalled();
    expect(mocks.runUsageQuotaNotifications).not.toHaveBeenCalled();
    // Its usage is still recorded.
    expect(mocks.workspaceUpdate).toHaveBeenCalledTimes(1);
  });
});
