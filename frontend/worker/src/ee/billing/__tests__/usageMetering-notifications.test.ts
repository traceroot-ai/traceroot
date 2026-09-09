import { describe, it, expect, vi, beforeEach } from "vitest";

// Drives the real runBillingJob → processWorkspace flow with all IO mocked,
// to pin the usage-quota notification wiring: free plans only, meters fed
// from the same numbers the job meters against, and a notification failure
// never breaking the billing write or the rest of the job.

const mocks = vi.hoisted(() => ({
  workspaceFindMany: vi.fn(),
  workspaceUpdate: vi.fn(),
  detectorRcaCount: vi.fn(),
  getWorkspaceUsageDetails: vi.fn(),
  runUsageQuotaNotifications: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    workspace: { findMany: mocks.workspaceFindMany, update: mocks.workspaceUpdate },
    detectorRca: { count: mocks.detectorRcaCount },
    aIMessage: {
      count: vi.fn().mockResolvedValue(0),
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
  AI_RUN_QUOTAS: { free: { included: 30 }, pro: { included: 100 } },
  RCA_RUN_QUOTAS: { free: { included: 30 }, pro: { included: 100 } },
  DETECTOR_RUN_QUOTAS: { free: { included: 100 }, pro: { included: Infinity } },
  EVENT_QUOTAS: { free: { included: 50_000 }, pro: { included: 150_000 } },
}));

vi.mock("../clickhouse.js", () => ({
  getWorkspaceUsageDetails: mocks.getWorkspaceUsageDetails,
}));

vi.mock("../usageNotifications.js", () => ({
  runUsageQuotaNotifications: mocks.runUsageQuotaNotifications,
}));

import { runBillingJob } from "../usageMetering.js";

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-free",
    name: "Acme",
    billingPlan: "free",
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    projects: [{ id: "proj-1" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  mocks.workspaceFindMany.mockResolvedValue([workspace()]);
  mocks.workspaceUpdate.mockResolvedValue({});
  mocks.detectorRcaCount.mockResolvedValue(7);
  mocks.getWorkspaceUsageDetails.mockResolvedValue({ traces: 100, spans: 900, detectorRuns: 3 });
  mocks.runUsageQuotaNotifications.mockResolvedValue(undefined);
});

describe("runBillingJob usage-quota notification wiring", () => {
  it("calls the notifier for a free workspace with the metered usage and free-plan caps", async () => {
    await runBillingJob();

    expect(mocks.runUsageQuotaNotifications).toHaveBeenCalledTimes(1);
    const args = mocks.runUsageQuotaNotifications.mock.calls[0][0];
    expect(args.workspaceId).toBe("ws-free");
    expect(args.workspaceName).toBe("Acme");
    expect(args.periodStart.getTime()).toBe(0); // free plans measure all-time
    expect(args.meters).toEqual([
      { meter: "events", used: 1000, cap: 50_000 }, // traces + spans
      { meter: "rca", used: 7, cap: 30 }, // detectorRca count
      { meter: "detector", used: 3, cap: 100 },
    ]);
  });

  it("never calls the notifier for paid plans", async () => {
    mocks.workspaceFindMany.mockResolvedValue([
      workspace({ id: "ws-pro", billingPlan: "pro" }),
      workspace({ id: "ws-ent", billingPlan: "enterprise" }),
    ]);

    await runBillingJob();

    expect(mocks.runUsageQuotaNotifications).not.toHaveBeenCalled();
  });

  it("runs the notifier only after the workspace flags/usage write", async () => {
    await runBillingJob();

    const updateOrder = mocks.workspaceUpdate.mock.invocationCallOrder[0];
    const notifyOrder = mocks.runUsageQuotaNotifications.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(notifyOrder);
  });

  it("a notifier failure neither throws nor stops later workspaces", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.workspaceFindMany.mockResolvedValue([
      workspace({ id: "ws-a" }),
      workspace({ id: "ws-b" }),
    ]);
    mocks.runUsageQuotaNotifications.mockRejectedValueOnce(new Error("smtp exploded"));

    await expect(runBillingJob()).resolves.toBeUndefined();

    // both workspaces still got their billing write and their notification attempt
    expect(mocks.workspaceUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.runUsageQuotaNotifications).toHaveBeenCalledTimes(2);
    expect(mocks.runUsageQuotaNotifications.mock.calls[1][0].workspaceId).toBe("ws-b");

    // the failure must be contained by the notification-level catch, not
    // escape to the per-workspace catch (whose log would mean the billing
    // flow itself was aborted by a notification problem)
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(
      logged.some((m) => m.includes("Usage-quota notifications failed for workspace ws-a")),
    ).toBe(true);
    expect(logged.some((m) => m.includes("Error processing workspace"))).toBe(false);
    errorSpy.mockRestore();
  });
});
