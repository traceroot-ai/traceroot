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
    async del(key: string) {
      return this.hashes.delete(key) ? 1 : 0;
    },
    /** The set commands the unmarked partitions use. */
    sets: new Map<string, Set<string>>(),
    async sadd(key: string, member: string) {
      if (!this.sets.has(key)) this.sets.set(key, new Set());
      const set = this.sets.get(key)!;
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    },
    async smembers(key: string) {
      return [...(this.sets.get(key) ?? [])];
    },
    async srem(key: string, ...members: string[]) {
      return members.filter((m) => this.sets.get(key)?.delete(m)).length;
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
const { mockStartRcas, mockSweepRcas } = vi.hoisted(() => ({
  mockStartRcas: vi.fn(),
  mockSweepRcas: vi.fn(),
}));
vi.mock("../rca.js", () => ({ startSettledRcas: mockStartRcas, sweepSignalRcas: mockSweepRcas }));
const { mockPendingCopies, detectorRows, detectorDb, markWrites } = vi.hoisted(() => {
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
  /**
   * The two raw writes of the pending mark: set it (enqueue), or clear it if it
   * is no newer than the cutoff (drain). Raw, so the detector's updateTime is
   * left alone; a client update here would be a bug.
   */
  const markWrites = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("assignment_pending_at = NULL")) {
      const [id, projectId, cutoff] = values as [string, string, Date];
      const row = detectorRows.get(id);
      if (!row || row.projectId !== projectId || !row.assignmentPendingAt) return 0;
      if (row.assignmentPendingAt > cutoff) return 0;
      row.assignmentPendingAt = null;
      return 1;
    }
    const [at, id, projectId] = values as [Date, string, string];
    const row = detectorRows.get(id);
    if (!row || row.projectId !== projectId) return 0;
    row.assignmentPendingAt = at;
    return 1;
  });
  const detectorDb = {
    updateMany: vi.fn(),
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      [...detectorRows]
        .filter(([id, row]) => matches(id, row, where))
        .sort((a, b) => a[1].assignmentPendingAt!.getTime() - b[1].assignmentPendingAt!.getTime())
        .slice(0, take)
        .map(([id, row]) => ({ id, projectId: row.projectId })),
    ),
  };
  return { mockPendingCopies: vi.fn(), detectorRows, detectorDb, markWrites };
});
vi.mock("@traceroot/core", () => ({
  prisma: {
    tag: "prisma",
    $queryRaw: mockPendingCopies,
    $executeRaw: markWrites,
    detector: detectorDb,
  },
}));
const { mockEmbed, mockChat, mockJev } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockChat: vi.fn(() => ({ tag: "chat" })),
  mockJev: vi.fn(() => ({ tag: "jev" })),
}));
vi.mock("../embedding.js", () => ({ embedTexts: mockEmbed }));
vi.mock("../models.js", () => ({
  createChatModels: mockChat,
  createJevModels: mockJev,
}));

import { DelayedError, type Job } from "bullmq";
import {
  enqueueAssignment,
  enqueueSignalHits,
  markDrained,
  partitionsToSweep,
  clearHitFailures,
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
  fakeRedis.sets.clear();
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

  it("writes the pending mark without touching the detector's last-edit time", async () => {
    detector("d1", null, "p1");
    await enqueueAssignment("p1", "d1");
    await markDrained("p1", "d1", Date.now() + 60_000);
    // Both writes are raw SQL that sets only the mark; a client update would
    // advance updateTime, which the detector list shows as the last edit.
    expect(detectorDb.updateMany).not.toHaveBeenCalled();
    for (const [strings] of markWrites.mock.calls) {
      expect((strings as TemplateStringsArray).join("?")).not.toContain("update_time");
    }
    expect(markWrites).toHaveBeenCalledTimes(2);
  });

  it("rejects ids that would corrupt the job id, before marking anything", async () => {
    await expect(enqueueAssignment("p:1", "d1")).rejects.toThrow();
    expect(markWrites).not.toHaveBeenCalled();
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

  it("starts over after the hit's failures are cleared", async () => {
    await recordHitFailure("r2", T0);
    await clearHitFailures("r2");
    expect(await recordHitFailure("r2", T0 + 60_000)).toEqual({ count: 1, firstAt: T0 + 60_000 });
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
    expect(markWrites).not.toHaveBeenCalled();
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
    expect(mockSweepRcas).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "prisma" }),
      expect.anything(),
      T0,
    );
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

describe("recovery of a failed pending mark", () => {
  const hit = {
    projectId: "p1",
    detectors: [{ id: "d1", enableSignals: true }],
    triggered: [{ detectorId: "d1" }],
  };
  const unmarkedSet = () => fakeRedis.sets.get("signals:assign:unmarked") ?? new Set<string>();
  /** The partitions on record, one entry per failed mark, without the nonces. */
  const unmarked = () => [...unmarkedSet()].map((m) => m.split(":").slice(0, 2).join(":"));

  it("still adds the job, and keeps the partition in Redis until Postgres takes the mark", async () => {
    vi.useFakeTimers({ now: T0 });
    detector("d1", null, "p1");
    markWrites.mockRejectedValueOnce(new Error("postgres down"));
    await expect(enqueueSignalHits(hit)).rejects.toThrow("postgres down");
    expect(pendingAt("d1")).toBeNull();
    expect(unmarked()).toEqual(["p1:d1"]);
    expect(mockAdd).toHaveBeenCalledTimes(1);

    // Postgres is still down at the next sweep: the partition stays on record.
    markWrites.mockRejectedValueOnce(new Error("postgres down"));
    await expect(sweepPartitions(T0 + 60_000)).rejects.toThrow("postgres down");
    expect(unmarked()).toEqual(["p1:d1"]);

    // Postgres is back, and no further hit arrived: the sweeper writes the
    // mark and enqueues the partition, and from here the mark alone keeps it.
    vi.setSystemTime(T0 + 120_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0 + 120_000)).toBe(1);
    expect(pendingAt("d1")).toBe(T0 + 120_000);
    expect(unmarked()).toEqual([]);
    expect(mockAdd).toHaveBeenLastCalledWith(
      "assign",
      { projectId: "p1", detectorId: "d1" },
      expect.objectContaining({ jobId: "assign:p1:d1", delay: 0 }),
    );
    log.mockRestore();
  });

  it("keeps a failure recorded while the sweeper was writing the partition's mark", async () => {
    detector("d1", null, "p1");
    markWrites.mockRejectedValueOnce(new Error("postgres down"));
    await expect(enqueueSignalHits(hit)).rejects.toThrow("postgres down");
    // While the sweeper adds the partition's job, another hit's mark fails.
    mockAdd.mockImplementationOnce(async () => {
      markWrites.mockRejectedValueOnce(new Error("postgres down"));
      await expect(enqueueSignalHits(hit)).rejects.toThrow("postgres down");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0)).toBe(1);
    // The sweep forgot only the failure it read; the later one is swept next.
    expect(unmarked()).toEqual(["p1:d1"]);
    expect(await sweepPartitions(T0 + 60_000)).toBe(1);
    expect(unmarked()).toEqual([]);
    log.mockRestore();
  });

  it("marks a partition once however many of its marks failed", async () => {
    detector("d1", null, "p1");
    for (let i = 0; i < 3; i++) {
      markWrites.mockRejectedValueOnce(new Error("postgres down"));
      await expect(enqueueSignalHits(hit)).rejects.toThrow("postgres down");
    }
    expect(unmarked()).toEqual(["p1:d1", "p1:d1", "p1:d1"]);
    mockAdd.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0)).toBe(1);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(unmarked()).toEqual([]);
    log.mockRestore();
  });

  it("is still recorded when the job cannot be added either", async () => {
    detector("d1", null, "p1");
    markWrites.mockRejectedValueOnce(new Error("postgres down"));
    mockAdd.mockRejectedValueOnce(new Error("queue full"));
    await expect(enqueueSignalHits(hit)).rejects.toThrow("queue full");
    expect(unmarked()).toEqual(["p1:d1"]);
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
  it("embeds with the deployment key and uses Jev only with TraceRoot's TypeSafe key", async () => {
    mockRound.mockResolvedValue({ waiting: 0, remaining: false, readAt: T0 });
    await processSignalAssignJob(job({ projectId: "p", detectorId: "d" }), "tok");
    const deps = mockRound.mock.calls[0][0] as RoundDeps;
    expect(deps.db).toMatchObject({ tag: "prisma" });
    expect(deps.backend).toBeDefined();
    expect(deps.failures.record).toBe(recordHitFailure);
    await deps.startRcas("p", ["f1"]);
    expect(mockStartRcas).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "prisma" }),
      deps.backend,
      "p",
      ["f1"],
    );
    expect(deps.now()).toBeGreaterThan(0);

    await deps.embed(["a"]);
    expect(mockEmbed).toHaveBeenCalledWith(["a"], "sk-test");

    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await deps.models([])).toEqual({ chat: { tag: "chat" }, jev: null });
    // Read per job, like the OpenAI key: a key added later applies on restart.
    vi.stubEnv("TYPESAFE_API_KEY", " ts-managed ");
    expect(await deps.models([])).toEqual({ chat: { tag: "chat" }, jev: { tag: "jev" } });
    expect(mockJev).toHaveBeenCalledWith("ts-managed", []);
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
