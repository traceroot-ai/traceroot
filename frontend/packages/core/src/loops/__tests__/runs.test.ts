import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createRun, hasActiveRun } from "../writes.ts";
import { listLoopRuns, listLoops, runToDto } from "../queries.ts";

function fakeTx(maxSeq: number | null) {
  const calls: string[] = [];
  const queryRaw = vi.fn(async () => {
    calls.push("lock");
    return [];
  });
  const aggregate = vi.fn(async () => {
    calls.push("max");
    return { _max: { seq: maxSeq } };
  });
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    calls.push("insert");
    return { id: "r", ...args.data };
  });
  const findFirst = vi.fn();
  return {
    tx: {
      $queryRaw: queryRaw,
      loopRun: { aggregate, create, findFirst },
    } as unknown as Prisma.TransactionClient,
    calls,
    create,
    findFirst,
  };
}

describe("createRun", () => {
  it("locks the Loop, then takes the next sequence number", async () => {
    const { tx, calls, create } = fakeTx(4);
    await createRun(tx, { loopId: "l1", projectId: "p1", trigger: "manual" });
    expect(calls).toEqual(["lock", "max", "insert"]);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loopId: "l1",
        seq: 5,
        status: "pending",
        trigger: "manual",
        slotAt: null,
      }),
    });
  });

  it("starts at 1 and carries the claimed slot of a scheduled run", async () => {
    const { tx, create } = fakeTx(null);
    const slotAt = new Date("2026-11-12T09:00:00Z");
    await createRun(tx, { loopId: "l1", projectId: "p1", trigger: "schedule", slotAt });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ seq: 1, slotAt }) });
  });
});

describe("hasActiveRun", () => {
  it("looks for a pending or running run of the Loop", async () => {
    const { tx, findFirst } = fakeTx(0);
    findFirst.mockResolvedValueOnce({ id: "r" }).mockResolvedValueOnce(null);
    expect(await hasActiveRun(tx, "l1")).toBe(true);
    expect(await hasActiveRun(tx, "l1")).toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: { loopId: "l1", status: { in: ["pending", "running"] } },
      select: { id: true },
    });
  });
});

describe("runToDto", () => {
  it("serialises dates and the decimal cost", () => {
    const at = new Date("2026-11-11T09:00:00Z");
    const dto = runToDto({
      id: "r1",
      loopId: "l1",
      projectId: "p1",
      seq: 2,
      trigger: "schedule",
      slotAt: at,
      status: "succeeded",
      attempts: 1,
      sessionId: "s1",
      startedAt: at,
      finishedAt: at,
      summary: "ok",
      findingKeys: ["a"],
      tracesRead: 7,
      error: null,
      metadata: null,
      costUsd: { toString: () => "0.123456" } as unknown as Prisma.Decimal,
      createTime: at,
    });
    expect(dto).toMatchObject({ slotAt: at.toISOString(), costUsd: 0.123456, findingKeys: ["a"] });
  });
});

describe("listLoopRuns", () => {
  function fakeDb(groupKey: string | null | undefined) {
    const signal = {
      findFirst: vi.fn(async () => (groupKey === undefined ? null : { groupKey })),
    };
    const loopRun = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    return { db: { signal, loopRun } as unknown as Prisma.TransactionClient, signal, loopRun };
  }
  const input = {
    projectId: "p1",
    loop: { id: "l1", detectorId: "d1" },
    page: 0,
    limit: 50,
  };

  it("narrows to the runs that recorded one of this Loop's signals", async () => {
    const { db, signal, loopRun } = fakeDb("loop:timeout-in-search-tool");
    await listLoopRuns(db, { ...input, status: "succeeded", signalId: "sig-1" });
    expect(signal.findFirst).toHaveBeenCalledWith({
      where: { id: "sig-1", projectId: "p1", detectorId: "d1" },
      select: { groupKey: true },
    });
    expect(loopRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          loopId: "l1",
          status: "succeeded",
          findingKeys: { has: "timeout-in-search-tool" },
        },
      }),
    );
  });

  it("answers no runs for a signal that is not this Loop's, or has no finding key", async () => {
    for (const groupKey of [undefined, null, "detector-key"]) {
      const { db, loopRun } = fakeDb(groupKey);
      expect(await listLoopRuns(db, { ...input, signalId: "sig-x" })).toEqual({
        data: [],
        meta: { page: 0, limit: 50, total: 0 },
      });
      expect(loopRun.findMany).not.toHaveBeenCalled();
    }
  });

  it("reads no signal without a signal_id", async () => {
    const { db, signal, loopRun } = fakeDb(null);
    await listLoopRuns(db, { ...input, signalId: null });
    expect(signal.findFirst).not.toHaveBeenCalled();
    expect(loopRun.count).toHaveBeenCalledWith({ where: { loopId: "l1" } });
  });
});

describe("listLoops", () => {
  it("reads each Loop's last run with its own indexed lookup, not the whole run history", async () => {
    const at = new Date("2026-11-11T10:00:00Z");
    const loop = (id: string) => ({
      id,
      projectId: "p1",
      detectorId: `d-${id}`,
      name: id,
      template: null,
      instructions: "",
      scheduleKind: "daily",
      intervalHours: null,
      weekday: null,
      hour: 9,
      timezone: "UTC",
      status: "active",
      dryRun: false,
      model: null,
      provider: null,
      source: null,
      lookbackHours: 24,
      nextRunAt: null,
      lastRunAt: null,
      failureStreak: 0,
      createdBy: "u1",
      createTime: at,
      updateTime: at,
    });
    const run = { id: "r7", loopId: "l1", seq: 7, status: "succeeded", createTime: at };
    const findFirst = vi.fn(async (args: { where: { loopId: string } }) =>
      args.where.loopId === "l1" ? run : null,
    );
    const findMany = vi.fn();
    const db = {
      loop: { findMany: vi.fn(async () => [loop("l1"), loop("l2")]), count: vi.fn(async () => 2) },
      loopRun: { findFirst, findMany, groupBy: vi.fn(async () => []) },
      signal: { groupBy: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    const listed = await listLoops(db, { projectId: "p1", page: 0, limit: 50 });

    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst.mock.calls).toEqual([
      [{ where: { loopId: "l1" }, orderBy: { seq: "desc" } }],
      [{ where: { loopId: "l2" }, orderBy: { seq: "desc" } }],
    ]);
    expect(listed.data.map((l) => [l.id, l.lastRun?.seq ?? null])).toEqual([
      ["l1", 7],
      ["l2", null],
    ]);
  });
});
