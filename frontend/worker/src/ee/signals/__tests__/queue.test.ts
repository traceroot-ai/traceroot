import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd, mockUpsertScheduler, mockRound, fakeRedis } = vi.hoisted(() => {
  /** Just the sorted-set commands the sweeper records use. */
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const bound = (v: string | number) => (v === "-inf" ? -Infinity : Number(v));
  const fakeRedis = {
    sets,
    zadd: async (key: string, score: number, member: string) => void zset(key).set(member, score),
    zremrangebyscore: async (key: string, min: string | number, max: string | number) => {
      for (const [m, s] of zset(key)) if (s >= bound(min) && s <= bound(max)) zset(key).delete(m);
    },
    zrangebyscore: async (key: string, min: string | number, max: string | number) =>
      [...zset(key)]
        .filter(([, s]) => s >= bound(min) && s <= bound(max))
        .sort((a, b) => a[1] - b[1])
        .flatMap(([m, s]) => [m, String(s)]),
    zmscore: async (key: string, ...members: string[]) =>
      members.map((m) => (zset(key).has(m) ? String(zset(key).get(m)) : null)),
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
const { mockPendingCopies } = vi.hoisted(() => ({ mockPendingCopies: vi.fn() }));
vi.mock("@traceroot/core", () => ({
  prisma: { tag: "prisma", $queryRaw: mockPendingCopies },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockPendingCopies.mockResolvedValue([]);
  fakeRedis.sets.clear();
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

  it("records the enqueue before adding the job, so a lost add is still swept", async () => {
    vi.useFakeTimers({ now: T0 });
    mockAdd.mockRejectedValueOnce(new Error("redis blip"));
    await expect(enqueueAssignment("p1", "d1")).rejects.toThrow("redis blip");
    expect(fakeRedis.sets.get("signals:assign:enqueued")?.get("p1:d1")).toBe(T0);
  });

  it("rejects ids that would corrupt the job id or the sweeper's records", async () => {
    await expect(enqueueAssignment("p:1", "d1")).rejects.toThrow();
    expect(fakeRedis.sets.size).toBe(0);
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
  const enqueuedAt = (member: string, t: number) =>
    fakeRedis.zadd("signals:assign:enqueued", t, member);

  it("returns partitions enqueued over two minutes ago and not drained since", async () => {
    await enqueuedAt("p:never", T0 - 180_000);
    await enqueuedAt("p:drained", T0 - 180_000);
    await markDrained("p", "drained", T0 - 150_000);
    await enqueuedAt("p:after", T0 - 180_000);
    await markDrained("p", "after", T0 - 200_000);
    await enqueuedAt("p:fresh", T0 - 60_000);
    expect(await partitionsToSweep(T0)).toEqual([
      { projectId: "p", detectorId: "never" },
      { projectId: "p", detectorId: "after" },
    ]);
  });

  it("does not trust a drain read just before the enqueue (clock skew, lagging reads)", async () => {
    await enqueuedAt("p:skew", T0 - 180_000);
    await markDrained("p", "skew", T0 - 175_000);
    expect(await partitionsToSweep(T0)).toEqual([{ projectId: "p", detectorId: "skew" }]);
  });

  it("forgets records older than the lookback", async () => {
    await enqueuedAt("p:ancient", T0 - 8 * 24 * 3_600_000);
    await markDrained("p", "ancient", T0 - 8 * 24 * 3_600_000 - 1);
    expect(await partitionsToSweep(T0)).toEqual([]);
    expect(fakeRedis.sets.get("signals:assign:enqueued")?.size).toBe(0);
    expect(fakeRedis.sets.get("signals:assign:drained")?.size).toBe(0);
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

  it("completes after a round that found nothing, and records the read as a drain", async () => {
    mockRound.mockResolvedValueOnce(stats({}));
    const j = job({ projectId: "p", detectorId: "d" });
    await processSignalAssignJob(j, "tok", deps);
    expect(mockRound).toHaveBeenCalledWith(deps, "p", "d");
    expect(j.moveToDelayed).not.toHaveBeenCalled();
    expect(fakeRedis.sets.get("signals:assign:drained")?.get("p:d")).toBe(T0);
  });

  it("continues at once while hits remain", async () => {
    vi.useFakeTimers({ now: T0 });
    mockRound.mockResolvedValueOnce(stats({ waiting: 200, remaining: true }));
    const j = job({ projectId: "p", detectorId: "d" });
    await expect(processSignalAssignJob(j, "tok", deps)).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(T0, "tok");
  });

  it("leaves a partition skipped for a missing key to the sweeper", async () => {
    mockRound.mockResolvedValueOnce(stats({ skipped: "no-key" }));
    await processSignalAssignJob(job({ projectId: "p", detectorId: "d" }), "tok", deps);
    expect(fakeRedis.sets.get("signals:assign:drained")).toBeUndefined();
  });

  it("takes one more look after a round that did work, before completing", async () => {
    vi.useFakeTimers({ now: T0 });
    mockRound.mockResolvedValueOnce(stats({ waiting: 3 }));
    const j = job({ projectId: "p", detectorId: "d" });
    await expect(processSignalAssignJob(j, "tok", deps)).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(T0 + 30_000, "tok");
    expect(fakeRedis.sets.get("signals:assign:drained")).toBeUndefined();
  });
});

describe("sweepPartitions", () => {
  it("does nothing without the signals key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await fakeRedis.zadd("signals:assign:enqueued", T0 - 180_000, "p:d");
    expect(await sweepPartitions(T0)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("re-enqueues the partitions that may have lost their job, without delay", async () => {
    await fakeRedis.zadd("signals:assign:enqueued", T0 - 180_000, "p:d");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepPartitions(T0)).toBe(1);
    expect(mockAdd).toHaveBeenCalledWith(
      "assign",
      { projectId: "p", detectorId: "d" },
      expect.objectContaining({ jobId: "assign:p:d", delay: 0 }),
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
