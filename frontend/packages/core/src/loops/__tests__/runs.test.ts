import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createRun, hasActiveRun, runToDto } from "../runs.ts";

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
