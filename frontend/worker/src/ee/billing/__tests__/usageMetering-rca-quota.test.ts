import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the RCA run meter to *completed* RCAs.
//
// `detector_rcas` holds a row for every finding that would run RCA, so the
// table also carries "pending"/"running" rows and two flavours of "failed":
// genuine agent errors, and the rcaBlocked skip path (detector-rca-processor)
// which writes status="failed" only to terminate the UI's "in progress" state.
// Metering all of them let a Free workspace's counter climb past its cap on
// rows that produced nothing, and billed paid plans for the same.
//
// `detectorRca.count` is mocked as a real filter over a fixture set rather than
// a fixed number, so these tests fail if the status predicate is ever dropped.

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
  // Real Free-plan semantics — these tests assert the hard cap, so a stub that
  // always returns false would make the blocking assertions vacuous.
  isRcaRunBlocked: (plan: string, runsUsed: number) => plan === "free" && runsUsed >= 30,
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

/** Statuses of the detector_rcas rows the mocked count queries against. */
let rcaRows: string[] = [];

/** Stand-in for `prisma.detectorRca.count` that honours `where.status`. */
function countRcaRows(args: { where?: { status?: string } }): number {
  const wanted = args?.where?.status;
  return wanted === undefined ? rcaRows.length : rcaRows.filter((s) => s === wanted).length;
}

function rows(counts: Partial<Record<"done" | "failed" | "running" | "pending", number>>) {
  return Object.entries(counts).flatMap(([status, n]) => Array<string>(n ?? 0).fill(status));
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-free",
    name: "Acme",
    billingPlan: "free",
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    ingestionBlocked: false,
    aiBlocked: false,
    rcaBlocked: false,
    detectorBlocked: false,
    currentUsage: null,
    projects: [{ id: "proj-1" }],
    ...overrides,
  };
}

/** The `data` payload of the single workspace write the job performs. */
function writtenData(): any {
  expect(mocks.workspaceUpdate).toHaveBeenCalledTimes(1);
  return mocks.workspaceUpdate.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  rcaRows = [];
  mocks.workspaceFindMany.mockResolvedValue([workspace()]);
  mocks.workspaceUpdate.mockResolvedValue({});
  mocks.detectorRcaCount.mockImplementation(async (args: any) => countRcaRows(args));
  mocks.getWorkspaceUsageDetails.mockResolvedValue({ traces: 100, spans: 900, detectorRuns: 3 });
  mocks.runUsageQuotaNotifications.mockResolvedValue(undefined);
});

describe("RCA run meter counts only completed RCAs", () => {
  it("scopes the count to status=done alongside the workspace and period filters", async () => {
    await runBillingJob();

    expect(mocks.detectorRcaCount).toHaveBeenCalledTimes(1);
    const where = mocks.detectorRcaCount.mock.calls[0][0].where;
    expect(where.status).toBe("done");
    // the pre-existing scoping must survive the added predicate
    expect(where.project).toEqual({ workspaceId: "ws-free" });
    expect(where.createTime).toBeDefined();
  });

  it("does not count a genuinely failed RCA", async () => {
    rcaRows = rows({ done: 4, failed: 3 });

    await runBillingJob();

    expect(writtenData().currentUsage.rca.runsUsed).toBe(4);
  });

  it("does not count a quota-skipped RCA (rcaBlocked writes status=failed)", async () => {
    // The skip path marks the pre-seeded row terminal so the UI stops showing
    // "in progress"; that row must not also consume quota.
    rcaRows = rows({ done: 12, failed: 9 });

    await runBillingJob();

    expect(writtenData().currentUsage.rca.runsUsed).toBe(12);
  });

  it("does not count RCAs still pending or running", async () => {
    rcaRows = rows({ done: 2, pending: 3, running: 1 });

    await runBillingJob();

    expect(writtenData().currentUsage.rca.runsUsed).toBe(2);
  });
});

describe("Free-plan RCA hard cap", () => {
  it("blocks a workspace at exactly 30 done RCAs", async () => {
    rcaRows = rows({ done: 30 });

    await runBillingJob();

    const data = writtenData();
    expect(data.currentUsage.rca.runsUsed).toBe(30);
    expect(data.rcaBlocked).toBe(true);
  });

  it("reads 30 done + 5 failed as 30, not 35", async () => {
    rcaRows = rows({ done: 30, failed: 5 });

    await runBillingJob();

    // still blocked — but on the 30 that actually ran, so the counter cannot
    // drift upward on rows the skip path keeps writing while blocked
    const data = writtenData();
    expect(data.currentUsage.rca.runsUsed).toBe(30);
    expect(data.rcaBlocked).toBe(true);
  });

  it("leaves a workspace under the cap unblocked even with many failed rows", async () => {
    rcaRows = rows({ done: 25, failed: 10 });

    await runBillingJob();

    // 35 total rows would have tripped the cap; 25 completed runs must not
    expect(writtenData().currentUsage.rca.runsUsed).toBe(25);
    expect(mocks.runUsageQuotaNotifications).toHaveBeenCalledTimes(1);
    expect(mocks.runUsageQuotaNotifications.mock.calls[0][0].meters).toContainEqual({
      meter: "rca",
      used: 25,
      cap: 30,
    });
  });

  it("clears a stale block once the failed rows no longer count", async () => {
    // A workspace blocked under the old all-rows count, now back under the cap.
    mocks.workspaceFindMany.mockResolvedValue([workspace({ rcaBlocked: true })]);
    rcaRows = rows({ done: 8, failed: 40 });

    await runBillingJob();

    const data = writtenData();
    expect(data.currentUsage.rca.runsUsed).toBe(8);
    expect(data.rcaBlocked).toBe(false);
  });
});
