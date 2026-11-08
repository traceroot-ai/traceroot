import { describe, expect, it, vi } from "vitest";
import type { WindowAggregates } from "@traceroot/core/updates";
import { executeRun } from "../execute.js";

const agg = (traces: number, errors: number): WindowAggregates => ({
  start: "2026-10-26T09:00:00Z",
  end: "2026-11-02T09:00:00Z",
  totals: {
    traces,
    errorTraces: errors,
    p50Ms: 1000,
    p95Ms: 2000,
    p99Ms: 3000,
    gitContextTraces: 0,
  },
  llm: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: "0" },
  byModel: [],
  byModelDay: [],
  tools: [],
  workflows: [],
  refs: [],
  truncated: [],
});

function setup(status = "pending") {
  const run = {
    id: "r1",
    projectId: "p1",
    status,
    timezone: "UTC",
    startedAt: null as Date | null,
    windowStart: new Date("2026-10-26T09:00:00Z"),
    windowEnd: new Date("2026-11-02T09:00:00Z"),
    prevWindowStart: new Date("2026-10-19T09:00:00Z"),
    prevWindowEnd: new Date("2026-10-26T09:00:00Z"),
  };
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    projectUpdateRun: {
      updateMany: vi.fn(
        async ({
          where,
        }: {
          where: { OR: Array<{ status: string | { in: string[] }; startedAt?: { lt: Date } }> };
        }) => {
          const claimable = where.OR.some((clause) => {
            const statuses = typeof clause.status === "string" ? [clause.status] : clause.status.in;
            if (!statuses.includes(run.status)) return false;
            return (
              clause.startedAt === undefined || (run.startedAt ?? new Date(0)) < clause.startedAt.lt
            );
          });
          if (!claimable) return { count: 0 };
          run.status = "running";
          run.startedAt = new Date();
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => run),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        run.status = data.status as string;
        return run;
      }),
    },
    project: { findFirst: vi.fn(async () => ({ id: "p1" })) },
    signal: { findMany: vi.fn(async () => []) },
    signalHit: { groupBy: vi.fn(async () => []) },
    signalStatusEvent: { findMany: vi.fn(async () => []) },
  };
  return { db, run, updates };
}

describe("executeRun", () => {
  it("stores the computed facts and marks the run succeeded", async () => {
    const { db, updates } = setup();
    const outcome = await executeRun(
      {
        db: db as never,
        readAggregates: async () => ({ current: agg(1000, 120), previous: agg(1000, 30) }),
        appBaseUrl: "http://app",
      },
      "r1",
    );
    expect(outcome.status).toBe("succeeded");
    expect(updates[0].status).toBe("succeeded");
    expect(JSON.stringify(updates[0].facts)).toContain("project:all traffic:error_rate");
  });

  it("does not run a job delivered twice", async () => {
    const { db } = setup();
    const deps = {
      db: db as never,
      readAggregates: async () => ({ current: agg(10, 0), previous: agg(10, 0) }),
      appBaseUrl: "http://app",
    };
    expect((await executeRun(deps, "r1")).status).toBe("succeeded");
    expect((await executeRun(deps, "r1")).status).toBe("skipped");
  });

  it("records a failure with its reason and lets a retry claim the run again", async () => {
    const { db, run } = setup();
    const failing = {
      db: db as never,
      readAggregates: async () => {
        throw new Error("backend down");
      },
      appBaseUrl: "http://app",
    };
    const outcome = await executeRun(failing, "r1");
    expect(outcome).toMatchObject({ status: "failed", error: "backend down" });
    expect(run.status).toBe("failed");
    const retry = await executeRun(
      { ...failing, readAggregates: async () => ({ current: agg(0, 0), previous: agg(0, 0) }) },
      "r1",
    );
    expect(retry.status).toBe("succeeded");
    expect(retry.facts?.nothingNotableReason).toBe("no_traffic");
  });

  it("takes over a run left running by a worker that died, but not a fresh one", async () => {
    const { db, run } = setup("running");
    const deps = {
      db: db as never,
      readAggregates: async () => ({ current: agg(0, 0), previous: agg(0, 0) }),
      appBaseUrl: "http://app",
    };
    run.startedAt = new Date(); // started just now: someone is on it
    expect((await executeRun(deps, "r1")).status).toBe("skipped");
    run.startedAt = new Date(Date.now() - 30 * 60_000);
    expect((await executeRun(deps, "r1")).status).toBe("succeeded");
  });

  it("stops, without retrying, a run whose project is gone", async () => {
    const { db, run } = setup();
    db.project.findFirst.mockResolvedValue(null as never);
    const outcome = await executeRun(
      {
        db: db as never,
        readAggregates: async () => ({ current: agg(0, 0), previous: agg(0, 0) }),
        appBaseUrl: "http://app",
      },
      "r1",
    );
    expect(outcome.status).toBe("stopped");
    expect(run.status).toBe("stopped");
  });
});
