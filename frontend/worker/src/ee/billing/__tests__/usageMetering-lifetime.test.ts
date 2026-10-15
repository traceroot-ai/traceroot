import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  lock: vi.fn(),
  query: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@traceroot/core", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../../packages/core/src/ee/billing/plans.ts",
  )),
  prisma: {
    workspace: { findMany: mocks.findMany },
    $transaction: async (callback: any) =>
      callback({
        $queryRaw: mocks.lock,
        workspace: { findUnique: mocks.findUnique, update: mocks.update },
      }),
    detectorRca: { count: vi.fn().mockResolvedValue(0) },
    aIMessage: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { id: 0 } }),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));
vi.mock("../clickhouse.js", () => ({ getWorkspaceUsageDetails: mocks.query }));
vi.mock("../usageNotifications.js", () => ({ runUsageQuotaNotifications: mocks.notify }));

import { runBillingJob } from "../usageMetering.js";
import { persistWorkspaceUsage } from "../persistWorkspaceUsage.js";

function usage(events = 0, scans = 0) {
  return {
    traces: events,
    spans: 0,
    detectorRuns: scans,
    bySource: {
      user: { traces: events, spans: 0 },
      detector: { traces: 0, spans: 0 },
      agent: { traces: 0, spans: 0 },
    },
  };
}

function project(id: string, deleted = false, eligible = true) {
  return {
    id,
    deleteTime: deleted ? new Date("2026-10-01T00:00:00Z") : null,
    freeQuotaEligible: eligible,
  };
}

function workspace() {
  return {
    id: "ws-1",
    name: "Acme",
    billingPlan: "free",
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPeriodStart: null as Date | null,
    billingPeriodEnd: null as Date | null,
    projects: [project("a")],
    freeLifetimeUsage: null as unknown,
    currentUsage: {} as any,
    ingestionBlocked: false,
    detectorBlocked: false,
    aiBlocked: false,
    rcaBlocked: false,
  };
}

let state: ReturnType<typeof workspace>;
let counts: Record<string, ReturnType<typeof usage>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ENABLE_BILLING", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  state = workspace();
  counts = { a: usage() };
  mocks.findMany.mockImplementation(async () => [structuredClone(state)]);
  mocks.findUnique.mockImplementation(async () => state);
  mocks.update.mockImplementation(async ({ data }) => Object.assign(state, data));
  mocks.query.mockImplementation(async ({ projectIds }: { projectIds: string[] }) => {
    const total = usage();
    for (const id of projectIds) {
      const value = counts[id];
      total.traces += value.traces;
      total.detectorRuns += value.detectorRuns;
      total.bySource.user.traces += value.traces;
    }
    return total;
  });
});

describe("free-plan lifetime usage", () => {
  it("keeps caps, displayed usage and notification totals after the last project is deleted", async () => {
    counts.a = usage(50_000, 100);
    await runBillingJob();
    state.projects[0].deleteTime = new Date();
    await runBillingJob();

    expect(mocks.findMany.mock.calls[0][0].include.projects).toEqual({
      where: { OR: [{ deleteTime: null }, { freeQuotaEligible: true }] },
      select: { id: true, deleteTime: true, freeQuotaEligible: true },
    });
    expect(mocks.query.mock.lastCall?.[0].projectIds).toEqual(["a"]);
    expect(state.ingestionBlocked).toBe(true);
    expect(state.detectorBlocked).toBe(true);
    expect(state.currentUsage).toMatchObject({ traces: 50_000, detector: { scansRun: 100 } });
    expect(mocks.notify.mock.lastCall?.[0].meters).toContainEqual({
      meter: "detector",
      used: 100,
      cap: 100,
    });
    expect(mocks.notify.mock.lastCall?.[0].meters).toContainEqual({
      meter: "events",
      used: 50_000,
      cap: 50_000,
    });
  });

  it("adds repeated below-cap projects rather than taking only the largest project", async () => {
    for (const id of ["a", "b", "c"]) {
      if (id !== "a") state.projects.push(project(id));
      counts[id] = usage(20_000, 60);
      await runBillingJob();
      state.projects.find((p) => p.id === id)!.deleteTime = new Date();
    }
    await runBillingJob();
    expect(state.currentUsage.traces).toBe(60_000);
    expect(state.currentUsage.detector.scansRun).toBe(180);
    expect(state.ingestionBlocked).toBe(true);
    expect(state.detectorBlocked).toBe(true);
  });

  it("counts projects created and deleted between ticks, excluding pre-rollout deletions", async () => {
    state.projects = [project("old", true, false), project("new", true)];
    counts.old = usage(100_000, 300);
    state.currentUsage = { traces: 100_000, detector: { scansRun: 300 } };
    counts.new = usage(123, 4);
    await runBillingJob();
    expect(mocks.query.mock.lastCall?.[0].projectIds).toEqual(["new"]);
    expect(state.currentUsage.traces).toBe(123);
    expect(state.currentUsage.detector.scansRun).toBe(4);
    expect(state.detectorBlocked).toBe(false);
  });

  it("preserves an observed floor when a later query has fewer rows or no projects", async () => {
    counts.a = usage(50_000, 100);
    await runBillingJob();
    state.projects = [];
    await runBillingJob();
    expect(state.currentUsage.traces).toBe(50_000);
    expect(state.currentUsage.bySource.user.traces).toBe(50_000);
    expect(state.detectorBlocked).toBe(true);
  });

  it("keeps paid active-project periods and preserves the floor across upgrades", async () => {
    counts.a = usage(50_000, 100);
    await runBillingJob();
    state.billingPlan = "pro";
    state.projects.push(project("deleted", true));
    counts.deleted = usage();
    state.billingPeriodStart = new Date("2026-10-01T00:00:00Z");
    state.billingPeriodEnd = new Date("2026-11-01T00:00:00Z");
    counts.a = usage(5, 1);
    await runBillingJob();
    expect(mocks.query.mock.lastCall?.[0]).toEqual({
      projectIds: ["a"],
      start: state.billingPeriodStart,
      end: state.billingPeriodEnd,
    });
    expect(state.currentUsage.traces).toBe(5);
    expect(state.ingestionBlocked).toBe(false);
    expect(state.detectorBlocked).toBe(false);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    state.billingPlan = "free";
    await runBillingJob();
    expect(state.currentUsage.traces).toBe(50_000);
    expect(state.detectorBlocked).toBe(true);
  });

  it("commits older measurements against the fresh floor under a row lock", async () => {
    await persistWorkspaceUsage(state.id, "free", usage(50_000, 100), { currentUsage: {} });
    await persistWorkspaceUsage(state.id, "free", usage(40_000, 80), { currentUsage: {} });
    expect(state.currentUsage.traces).toBe(50_000);
    expect(state.detectorBlocked).toBe(true);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("does not overwrite a changed plan or send stale notifications", async () => {
    mocks.query.mockImplementationOnce(async () => {
      state.billingPlan = "pro";
      return usage(50_000, 100);
    });
    await runBillingJob();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("ignores invalid saved counters and preserves each source independently", async () => {
    state.freeLifetimeUsage = {
      detectorRuns: -1,
      bySource: { user: { traces: "invalid", spans: -1 }, agent: { traces: 7, spans: 9 } },
    };
    await runBillingJob();
    expect(state.currentUsage).toMatchObject({ traces: 7, spans: 9, detector: { scansRun: 0 } });
    expect(state.currentUsage.bySource.agent).toEqual({ traces: 7, spans: 9 });
  });

  it("does not notify when persisting usage fails and continues with the next workspace", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findMany.mockResolvedValueOnce([state, { ...state, id: "ws-2" }]);
    mocks.update.mockRejectedValueOnce(new Error("database unavailable"));
    await runBillingJob();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.lastCall?.[0].workspaceId).toBe("ws-2");
    error.mockRestore();
  });
});
