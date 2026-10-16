import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  query: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@traceroot/core", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../../packages/core/src/ee/billing/plans.ts",
  )),
  prisma: {
    workspace: { findMany: mocks.findMany, update: mocks.update },
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
  mocks.update.mockImplementation(async ({ data }) => Object.assign(state, data));
  mocks.query.mockImplementation(async ({ projectIds }: { projectIds: string[] }) => {
    const total = usage();
    for (const id of projectIds) {
      const value = counts[id];
      total.traces += value.traces;
      total.spans += value.spans;
      total.detectorRuns += value.detectorRuns;
      total.bySource.user.traces += value.traces;
      total.bySource.user.spans += value.spans;
    }
    return total;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("free-plan lifetime usage", () => {
  it("keeps caps, displayed usage and notification totals after the last project is deleted", async () => {
    counts.a = usage(50_000, 100);
    await runBillingJob();
    state.projects[0].deleteTime = new Date();
    await runBillingJob();

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

  it.each(["traces", "spans", "detectorRuns"] as const)(
    "counts a rewritten %s row after the job captured its start time",
    async (field) => {
      const captured = new Date("2026-10-15T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(captured);
      counts.a = usage(50_000, 100);
      if (field === "spans") {
        counts.a.traces = 0;
        counts.a.spans = 50_000;
        counts.a.bySource.user = { traces: 0, spans: 50_000 };
      }
      await runBillingJob();
      expect(state.ingestionBlocked).toBe(true);
      expect(state.detectorBlocked).toBe(true);

      // Model the retained version after replacement/merge: one existing row
      // now has an insertion timestamp later than the pending job's start.
      // The previous fixed upper bound excluded it and cleared the hard cap.
      mocks.query.mockImplementationOnce(async ({ start, end }: { start: Date; end: Date }) => {
        const rewrittenAt = new Date(captured.getTime() + 1000);
        vi.setSystemTime(rewrittenAt);
        const measured = structuredClone(counts.a);
        if (rewrittenAt < start || rewrittenAt >= end) {
          measured[field] -= 1;
          if (field !== "detectorRuns") measured.bySource.user[field] -= 1;
        }
        return measured;
      });
      await runBillingJob();

      expect(state.currentUsage.updatedAt).toBe(captured.toISOString());
      expect(state.currentUsage.traces + state.currentUsage.spans).toBe(50_000);
      expect(state.currentUsage.detector.scansRun).toBe(100);
      expect(state.ingestionBlocked).toBe(true);
      expect(state.detectorBlocked).toBe(true);
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
    },
  );

  it("keeps paid active-project periods and re-counts eligible history on downgrade", async () => {
    counts.a = usage(50_000, 100);
    state.projects[0].deleteTime = new Date();
    state.projects.push(project("b"));
    counts.b = usage(5, 1);
    state.billingPlan = "pro";
    state.ingestionBlocked = true;
    state.detectorBlocked = true;
    state.billingPeriodStart = new Date("2026-10-01T00:00:00Z");
    state.billingPeriodEnd = new Date("2026-11-01T00:00:00Z");
    await runBillingJob();
    expect(mocks.query.mock.lastCall?.[0]).toEqual({
      projectIds: ["b"],
      start: state.billingPeriodStart,
      end: state.billingPeriodEnd,
    });
    expect(state.currentUsage.traces).toBe(5);
    expect(state.ingestionBlocked).toBe(false);
    expect(state.detectorBlocked).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
    state.billingPlan = "free";
    await runBillingJob();
    expect(state.currentUsage.traces).toBe(50_005);
    expect(state.detectorBlocked).toBe(true);
  });

  it("keeps the calendar-month fallback bounded for paid workspaces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    state.billingPlan = "pro";
    await runBillingJob();
    expect(mocks.query.mock.lastCall?.[0]).toEqual({
      projectIds: ["a"],
      start: new Date(2026, 9, 1),
      end: new Date(2026, 10, 1),
    });
  });

  it("logs event and detector block transitions without repeating unchanged flags", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    counts.a = usage(50_000, 100);
    await runBillingJob();
    await runBillingJob();
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages.filter((m) => m.includes("ingestion_blocked: true"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("detector_blocked: true"))).toHaveLength(1);
    expect(state.ingestionBlocked).toBe(true);
    expect(state.detectorBlocked).toBe(true);
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
