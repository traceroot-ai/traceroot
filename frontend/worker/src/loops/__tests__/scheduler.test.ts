/**
 * The tick's failure handling, with Postgres and Redis stubbed: one Loop or run
 * that fails is logged and skipped, and a failing step does not stop the next.
 * The claim, reclaim and enqueue themselves run against Postgres in
 * scheduler.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Prisma } from "@traceroot/core";

const { db, queue, startCronTick, finishLoopRun } = vi.hoisted(() => ({
  db: {
    loop: { findMany: vi.fn() },
    loopRun: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  queue: { add: vi.fn(), close: vi.fn() },
  startCronTick: vi.fn(),
  finishLoopRun: vi.fn(),
}));
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: db,
}));
vi.mock("../../queues/loop-run-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../queues/loop-run-queue.js")>()),
  createRedisConnection: vi.fn(() => ({})),
  createLoopRunQueue: vi.fn(() => queue),
}));
vi.mock("../../scheduling/cron-tick.js", () => ({ startCronTick }));
vi.mock("../finish.js", () => ({ finishLoopRun }));

import {
  claimDueLoops,
  closeLoopRunQueue,
  enqueuePendingRuns,
  reclaimStaleRuns,
  runLoopTick,
  startLoopScheduler,
} from "../scheduler.js";

const NOW = new Date("2026-11-11T10:02:00Z");
const dueLoop = (id: string) => ({
  id,
  projectId: "p1",
  nextRunAt: new Date("2026-11-11T10:00:00Z"),
  scheduleKind: "interval",
  intervalHours: 1,
  weekday: null,
  hour: null,
  timezone: null,
});

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeLoopRunQueue();
});

const loggedErrors = () => errors.mock.calls.map((call) => String(call[0]));

describe("claimDueLoops", () => {
  it("skips a slot another tick already ran quietly, and logs any other failure", async () => {
    db.loop.findMany.mockResolvedValue([dueLoop("l1"), dueLoop("l2")]);
    db.$transaction
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockRejectedValueOnce(new Error("deadlock"));
    expect(await claimDueLoops(NOW)).toEqual([]);
    expect(loggedErrors()).toEqual(["[Loops] claim failed loop=l2"]);
  });
});

describe("enqueuePendingRuns", () => {
  it("counts the runs it queued and logs the one it could not", async () => {
    db.loopRun.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    const add = vi.fn().mockRejectedValueOnce(new Error("redis down")).mockResolvedValue({});
    expect(await enqueuePendingRuns({ add })).toBe(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(loggedErrors()).toEqual(["[Loops] enqueue failed run=r1"]);
  });
});

describe("reclaimStaleRuns", () => {
  it("logs a run it could not reclaim and goes on to the next", async () => {
    const startedAt = new Date("2026-11-11T08:00:00Z");
    db.loopRun.findMany.mockResolvedValue([
      { id: "r1", loopId: "l1", trigger: "schedule", attempts: 1, startedAt },
      { id: "r2", loopId: "l1", trigger: "schedule", attempts: 1, startedAt },
    ]);
    db.loopRun.updateMany
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce({ count: 1 });
    const add = vi.fn().mockResolvedValue({});
    expect(await reclaimStaleRuns(NOW, { add }, 60_000)).toEqual({ retried: 1, failed: 0 });
    expect(add).toHaveBeenCalledWith("loop-run", { runId: "r2" }, expect.anything());
    expect(loggedErrors()).toEqual(["[Loops] reclaim failed run=r1"]);
  });
});

describe("runLoopTick", () => {
  it("runs every step when the ones before it fail", async () => {
    db.loop.findMany.mockRejectedValue(new Error("db down"));
    db.loopRun.findMany.mockRejectedValue(new Error("db down"));
    await runLoopTick(NOW, { add: vi.fn() });
    expect(loggedErrors()).toEqual([
      "[Loops] claim read failed",
      "[Loops] reclaim read failed",
      "[Loops] pending read failed",
    ]);
  });

  it("enqueues on the worker's own queue when given none, and closes it once", async () => {
    db.loop.findMany.mockResolvedValue([]);
    db.loopRun.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "r1" }]);
    queue.add.mockResolvedValue({});
    await runLoopTick(NOW);
    expect(queue.add).toHaveBeenCalledWith("loop-run", { runId: "r1" }, expect.anything());
    await closeLoopRunQueue();
    await closeLoopRunQueue();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});

describe("startLoopScheduler", () => {
  it("does not start unless LOOP_SCHEDULER_ENABLED is set", () => {
    vi.stubEnv("LOOP_SCHEDULER_ENABLED", "");
    expect(startLoopScheduler()).toBeUndefined();
    expect(startCronTick).not.toHaveBeenCalled();
  });

  it("ticks on LOOP_TICK_CRON once enabled", async () => {
    vi.stubEnv("LOOP_SCHEDULER_ENABLED", "true");
    vi.stubEnv("LOOP_TICK_CRON", "*/2 * * * *");
    const handle = { label: "Loops" };
    startCronTick.mockReturnValue(handle);
    expect(startLoopScheduler()).toBe(handle);
    const options = startCronTick.mock.calls[0][0];
    expect(options).toMatchObject({ label: "Loops", expression: "*/2 * * * *" });

    db.loop.findMany.mockResolvedValue([]);
    db.loopRun.findMany.mockResolvedValue([]);
    await options.tick(NOW);
    expect(db.loop.findMany).toHaveBeenCalledTimes(1);
  });
});
