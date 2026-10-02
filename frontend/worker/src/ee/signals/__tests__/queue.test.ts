import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd, mockUpsertScheduler, mockRound, fakeRedis } = vi.hoisted(() => {
  /** Just the hash commands the hit failure records use. */
  const fakeRedis = {
    hashes: new Map<string, Map<string, string>>(),
    expiries: new Map<string, number>(),
    hash(key: string) {
      if (!this.hashes.has(key)) this.hashes.set(key, new Map());
      return this.hashes.get(key)!;
    },
    async hincrby(key: string, field: string, by: number) {
      const h = this.hash(key);
      const v = Number(h.get(field) ?? 0) + by;
      h.set(field, String(v));
      return v;
    },
    async hsetnx(key: string, field: string, value: string) {
      const h = this.hash(key);
      if (h.has(field)) return 0;
      h.set(field, value);
      return 1;
    },
    async hget(key: string, field: string) {
      return this.hash(key).get(field) ?? null;
    },
    async pexpire(key: string, ms: number) {
      this.expiries.set(key, ms);
      return 1;
    },
  };
  return { mockAdd: vi.fn(), mockUpsertScheduler: vi.fn(), mockRound: vi.fn(), fakeRedis };
});
vi.mock("bullmq", () => {
  class Queue {
    add = mockAdd;
    upsertJobScheduler = mockUpsertScheduler;
  }
  class Worker {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor(
      public name: string,
      public processor: unknown,
      public opts: unknown,
    ) {}
    on(event: string, fn: (...a: unknown[]) => void) {
      this.handlers[event] = fn;
    }
  }
  class DelayedError extends Error {}
  return { Queue, Worker, DelayedError };
});
vi.mock("../../../queues/detector-run-queue.js", () => ({
  createRedisConnection: () => fakeRedis,
}));
vi.mock("../round.js", () => ({ runAssignmentRound: mockRound }));
const { mockEnqueueRca, mockSweepRcas } = vi.hoisted(() => ({
  mockEnqueueRca: vi.fn(),
  mockSweepRcas: vi.fn(),
}));
vi.mock("../rca.js", () => ({ enqueueSignalRca: mockEnqueueRca, sweepSignalRcas: mockSweepRcas }));
const { mockPendingCopies, detectorRows, detectorDb } = vi.hoisted(() => {
  /** The detectors table, reduced to the sweeper's pending mark. */
  const detectorRows = new Map<string, { projectId: string; assignmentPendingAt: Date | null }>();
  type Where = { id?: string; projectId?: string; assignmentPendingAt?: { lte?: Date; lt?: Date } };
  const matches = (
    id: string,
    row: { projectId: string; assignmentPendingAt: Date | null },
    w: Where,
  ) =>
    (w.id === undefined || w.id === id) &&
    (w.projectId === undefined || w.projectId === row.projectId) &&
    (w.assignmentPendingAt === undefined ||
      (row.assignmentPendingAt !== null &&
        (w.assignmentPendingAt.lte === undefined ||
          row.assignmentPendingAt <= w.assignmentPendingAt.lte) &&
        (w.assignmentPendingAt.lt === undefined ||
          row.assignmentPendingAt < w.assignmentPendingAt.lt)));
  const detectorDb = {
    updateMany: vi.fn(
      async ({ where, data }: { where: Where; data: { assignmentPendingAt: Date | null } }) => {
        let count = 0;
        for (const [id, row] of detectorRows)
          if (matches(id, row, where)) {
            row.assignmentPendingAt = data.assignmentPendingAt;
            count++;
          }
        return { count };
      },
    ),
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      [...detectorRows]
        .filter(([id, row]) => matches(id, row, where))
        .sort((a, b) => a[1].assignmentPendingAt!.getTime() - b[1].assignmentPendingAt!.getTime())
        .slice(0, take)
        .map(([id, row]) => ({ id, projectId: row.projectId })),
    ),
  };
  return { mockPendingCopies: vi.fn(), detectorRows, detectorDb };
});
vi.mock("@traceroot/core", () => ({
  prisma: { tag: "prisma", $queryRaw: mockPendingCopies, detector: detectorDb },
}));
const { mockEmbed, mockChat, mockJev, mockFindJev } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockChat: vi.fn(() => ({ tag: "chat" })),
  mockJev: vi.fn(() => ({ tag: "jev" })),
  mockFindJev: vi.fn(),
}));
vi.mock("../embedding.js", () => ({ embedTexts: mockEmbed }));
vi.mock("../models.js", () => ({
  createChatModels: mockChat,
  createJevModels: mockJev,
  findJevProvider: mockFindJev,
}));

import { DelayedError, type Job } from "bullmq";
import {
  enqueueAssignment,
  enqueueSignalHits,
  markDrained,
  partitionsToSweep,
  recordHitFailure,
  type SignalAssignJobData,
} from "../queue.js";
import { processSignalAssignJob, startSignalAssignWorker, sweepPartitions } from "../worker.js";
import type { RoundDeps } from "../round.js";

const T0 = Date.parse("2026-09-30T10:00:00Z");

/** A detector row of project "p" with the given pending mark. */
const detector = (id: string, pendingAt: number | null, projectId = "p") =>
  detectorRows.set(id, {
    projectId,
    assignmentPendingAt: pendingAt === null ? null : new Date(pendingAt),
  });
const pendingAt = (id: string) => detectorRows.get(id)?.assignmentPendingAt?.getTime() ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  mockPendingCopies.mockResolvedValue([]);
  detectorRows.clear();
  fakeRedis.hashes.clear();
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  mockAdd.mockResolvedValue(undefined);
  mockUpsertScheduler.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("enqueueAssignment", () => {
  it("adds one delayed job per partition that leaves nothing behind", async () => {
    await enqueueAssignment("p1", "d1");
    expect(mockAdd).toHaveBeenCalledWith(
      "assign",
      { projectId: "p1", detectorId: "d1" },
      expect.objectContaining({
        jobId: "assign:p1:d1",
        delay: 30_000,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
      }),
    );
  });

  it("marks the partition pending in Postgres before adding the job, so a failed add is still swept", async () => {
    vi.useFakeTimers({ now: T0 });
    detector("d1", null, "p1");
    mockAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(enqueueAssignment("p1", "d1")).rejects.toThrow("redis down");
    expect(pendingAt("d1")).toBe(T0);
  });

  it("rejects ids that would corrupt the job id, before marking anything", async () => {
    await expect(enqueueAssignment("p:1", "d1")).rejects.toThrow();
    expect(detectorDb.updateMany).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("enqueueSignalHits", () => {
  const params = {
    projectId: "p1",
    detectors: [
      { id: "on", enableSignals: true },
      { id: "also", enableSignals: true },
      { id: "off", enableSignals: false },
    ],
    triggered: [
      { detectorId: "on" },
      { detectorId: "off" },
      { detectorId: "also" },
      { detectorId: "on" },
    ],
  };

  it("enqueues each triggered detector with signals on, once", async () => {
    expect(await enqueueSignalHits(params)).toBe(2);
    expect(mockAdd.mock.calls.map((c) => c[2].jobId)).toEqual(["assign:p1:on", "assign:p1:also"]);
  });

  it("tries every partition before reporting a failed enqueue", async () => {
    mockAdd.mockRejectedValueOnce(new Error("redis blip"));
    await expect(enqueueSignalHits(params)).rejects.toThrow("redis blip");
    expect(mockAdd.mock.calls.map((c) => c[2].jobId)).toEqual(["assign:p1:on", "assign:p1:also"]);
  });

  it("enqueues nothing without a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await enqueueSignalHits(params)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("partitionsToSweep", () => {
  it("returns partitions marked pending over two minutes ago, oldest first", async () => {
    detector("fresh", T0 - 60_000);
    detector("newer", T0 - 150_000);
    detector("older", T0 - 600_000);
    detector("idle", null);
    expect(await partitionsToSweep(T0)).toEqual([
      { projectId: "p", detectorId: "older" },
      { projectId: "p", detectorId: "newer" },
    ]);
  });

  it("forgets a partition once a round drained it", async () => {
    detector("d", T0 - 180_000);
    await markDrained("p", "d", T0 - 150_000);
    expect(pendingAt("d")).toBeNull();
    expect(await partitionsToSweep(T0)).toEqual([]);
  });

  it("keeps a mark written after the drain's read, or too close before it (clock skew)", async () => {
    detector("after", T0 - 180_000);
    await markDrained("p", "after", T0 - 200_000);
    detector("skew", T0 - 180_000);
    await markDrained("p", "skew", T0 - 175_000);
    expect(await partitionsToSweep(T0)).toEqual([
      { projectId: "p", detectorId: "after" },
      { projectId: "p", detectorId: "skew" },
    ]);
  });
});

describe("recordHitFailure", () => {
  it("counts failures, keeps the first failure time, and expires with the lookback", async () => {
    expect(await recordHitFailure("r1", T0)).toEqual({ count: 1, firstAt: T0 });
    expect(await recordHitFailure("r1", T0 + 60_000)).toEqual({ count: 2, firstAt: T0 });
    expect(fakeRedis.expiries.get("signals:assign:failures:r1")).toBe(7 * 24 * 3_600_000);
  });
});

const job = (data: SignalAssignJobData, name = "assign") =>
  ({ name, data, moveToDelayed: vi.fn() }) as unknown as Job<SignalAssignJobData> & {
    moveToDelayed: ReturnType<typeof vi.fn>;
  };

describe("processSignalAssignJob", () => {
  const deps = { db: {} } as RoundDeps;
  const stats = (over: Record<string, unknown>) => ({
    waiting: 0,
    remaining: false,
    readAt: T0,
    ...over,
  });

  it("runs the sweeper for the scheduler's job", async () => {
    await processSignalAssignJob(job({ sweep: true }, "sweep"), "tok", deps);
    expect(mockRound).not.toHaveBeenCalled();
  });

  it("completes after a round that found nothing, and clears the partition's pending mark", async () => {
    detector("d", T0 - 60_000);
    mockRound.mockResolvedValueOnce(stats({}));
    const j = job({ projectId: "p", detectorId: "d" });
    await processSignalAssignJob(j, "tok", deps);
    expect(mockRound).toHaveBeenCalledWith(deps, "p", "d");
    expect(j.moveToDelayed).not.toHaveBeenCalled();
    expect(pendingAt("d")).toBeNull();
  });

  it("continues at once while hits remain", async () => {
    vi.useFakeTimers({ now: T0 });
    mockRound.mockResolvedValueOnce(stats({ waiting: 200, remaining: true }));
    const j = job({ projectId: "p", detectorId: "d" });
    await expect(processSignalAssignJob(j, "tok", deps)).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(T0, "tok");
  });

  it("leaves a partition skipped for a missing key to the sweeper", async () => {
    detector("d", T0 - 60_000);
    mockRound.mockResolvedValueOnce(stats({ skipped: "no-key" }));
    await processSignalAssignJob(job({ projectId: "p", detectorId: "d" }), "tok", deps);
    expect(pendingAt("d")).toBe(T0 - 60_000);
  });

  it("takes one more look after a round that did work, before completing", async () => {
    vi.useFakeTimers({ now: T0 });
    mockRound.mockResolvedValueOnce(stats({ waiting: 3 }));
    const j = job({ projectId: "p", detectorId: "d" });
    await expect(processSignalAssignJob(j, "tok", deps)).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(T0 + 30_000, "tok");
    expect(detectorDb.updateMany).not.toHaveBeenCalled();
  });
});

describe("sweepPartitions", () => {
  it("does nothing without the signals key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    detector("d", T0 - 180_000);
    expect(await sweepPartitions(T0)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("re-enqueues the partitions that may have lost their job, without delay", async () => {
    detector("d", T0 - 180_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0)).toBe(1);
    expect(mockSweepRcas).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), T0);
    expect(mockAdd).toHaveBeenCalledWith(
      "assign",
      { projectId: "p", detectorId: "d" },
      expect.objectContaining({ jobId: "assign:p:d", delay: 0 }),
    );
    log.mockRestore();
  });
});

describe("recovery of a failed first enqueue", () => {
  it("assigns the hit later without another hit arriving", async () => {
    vi.useFakeTimers({ now: T0 });
    detector("d1", null, "p1");
    mockAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      enqueueSignalHits({
        projectId: "p1",
        detectors: [{ id: "d1", enableSignals: true }],
        triggered: [{ detectorId: "d1" }],
      }),
    ).rejects.toThrow("redis down");
    expect(mockAdd).toHaveBeenCalledTimes(1);

    // No further hit: the sweeper alone finds the partition once the mark is stale.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0 + 60_000)).toBe(0);
    expect(await sweepPartitions(T0 + 180_000)).toBe(1);
    expect(mockAdd).toHaveBeenLastCalledWith(
      "assign",
      { projectId: "p1", detectorId: "d1" },
      expect.objectContaining({ jobId: "assign:p1:d1", delay: 0 }),
    );
    log.mockRestore();
  });
});

describe("pending copy recovery", () => {
  it("reaches later partitions even while the first full page stays pending", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mockPendingCopies
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => ({
          projectId: "p",
          detectorId: `d${String(i).padStart(3, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ projectId: "p", detectorId: "d500" }]);
    expect(await sweepPartitions(T0)).toBe(501);
    expect(mockPendingCopies.mock.calls[1].slice(1)).toEqual(["p", "p", "d499", 500]);
    expect(mockAdd).toHaveBeenCalledTimes(501);
    expect(mockAdd).toHaveBeenLastCalledWith(
      "assign",
      { projectId: "p", detectorId: "d500" },
      expect.objectContaining({ delay: 0 }),
    );
  });

  it("enqueues durable repairs without a model key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mockPendingCopies.mockResolvedValue([{ projectId: "p1", detectorId: "d1" }]);
    expect(await sweepPartitions(T0)).toBe(1);
    expect(mockAdd).toHaveBeenCalledWith(
      "assign",
      { projectId: "p1", detectorId: "d1" },
      expect.objectContaining({ delay: 0 }),
    );
    expect(mockSweepRcas).not.toHaveBeenCalled();
  });
});

describe("production wiring", () => {
  it("embeds with the deployment key and uses Jev only when the workspace has a TypeSafe key", async () => {
    mockRound.mockResolvedValue({ waiting: 0, remaining: false, readAt: T0 });
    await processSignalAssignJob(job({ projectId: "p", detectorId: "d" }), "tok");
    const deps = mockRound.mock.calls[0][0] as RoundDeps;
    expect(deps.db).toMatchObject({ tag: "prisma" });
    expect(deps.backend).toBeDefined();
    expect(deps.failures.record).toBe(recordHitFailure);
    await deps.enqueueRca("f1", "p");
    expect(mockEnqueueRca).toHaveBeenCalledWith("f1", "p");
    expect(deps.now()).toBeGreaterThan(0);

    await deps.embed(["a"]);
    expect(mockEmbed).toHaveBeenCalledWith(["a"], "sk-test");

    mockFindJev.mockResolvedValueOnce(null);
    expect(await deps.models("ws", [])).toEqual({ chat: { tag: "chat" }, jev: null });
    mockFindJev.mockResolvedValueOnce({ key: "ts" });
    expect(await deps.models("ws", [])).toEqual({ chat: { tag: "chat" }, jev: { tag: "jev" } });
    expect(mockFindJev).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), "ws");
  });
});

describe("startSignalAssignWorker", () => {
  it("sets the lock duration explicitly and schedules the sweeper", async () => {
    const worker = startSignalAssignWorker() as unknown as {
      opts: Record<string, unknown>;
      handlers: Record<string, (...a: unknown[]) => void>;
    };
    expect(worker.opts).toMatchObject({ concurrency: 4, lockDuration: 180_000 });
    expect(mockUpsertScheduler).toHaveBeenCalledWith(
      "signal-assign-sweeper",
      { every: 60_000 },
      expect.objectContaining({ name: "sweep", data: { sweep: true } }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    worker.handlers.failed({ id: "j" }, new DelayedError());
    expect(error).not.toHaveBeenCalled();
    worker.handlers.failed({ id: "j" }, new Error("boom"));
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
