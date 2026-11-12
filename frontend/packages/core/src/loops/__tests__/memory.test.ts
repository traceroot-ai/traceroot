import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { isExpired, listMemory, upsertMemory } from "../memory.ts";
import { LOOP_MEMORY } from "../contracts.ts";

const now = new Date("2026-11-11T12:00:00Z");

function fakeDb(rows: Record<string, unknown>[] = []) {
  const upsert = vi.fn(async () => ({ id: "m1" }));
  const findMany = vi.fn(async () => rows);
  return {
    db: { loopMemory: { upsert, findMany } } as unknown as Prisma.TransactionClient,
    upsert,
    findMany,
  };
}

describe("isExpired", () => {
  it("treats no expiry as never, and the expiry instant itself as expired", () => {
    expect(isExpired({ expiresAt: null }, now)).toBe(false);
    expect(isExpired({ expiresAt: new Date(now.getTime() + 1) }, now)).toBe(false);
    expect(isExpired({ expiresAt: now }, now)).toBe(true);
  });
});

describe("upsertMemory", () => {
  it("upserts on (project, key) with the trimmed key and records the writer", async () => {
    const { db, upsert } = fakeDb();
    const result = await upsertMemory(db, {
      projectId: "p1",
      loopId: "l1",
      key: "  known-flake  ",
      content: "retry storms after 02:00",
      runId: "r1",
    });
    expect(result).toEqual({ ok: true, id: "m1" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_key: { projectId: "p1", key: "known-flake" } },
        update: {
          loopId: "l1",
          content: "retry storms after 02:00",
          expiresAt: null,
          updatedByRunId: "r1",
        },
      }),
    );
  });

  it("refuses an empty or oversized key and oversized content without writing", async () => {
    const { db, upsert } = fakeDb();
    const base = { projectId: "p1", loopId: null, content: "x" };
    expect((await upsertMemory(db, { ...base, key: " " })).ok).toBe(false);
    expect(
      (await upsertMemory(db, { ...base, key: "k".repeat(LOOP_MEMORY.keyMaxLength + 1) })).ok,
    ).toBe(false);
    const big = await upsertMemory(db, {
      ...base,
      key: "k",
      content: "é".repeat(LOOP_MEMORY.contentMaxBytes / 2 + 1), // two bytes each
    });
    expect(big).toEqual({ ok: false, error: expect.stringContaining("bytes") });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("listMemory", () => {
  const row = (key: string, expiresAt: Date | null, loopId: string | null = null) => ({
    id: key,
    loopId,
    key,
    content: "c",
    expiresAt,
    updatedByRunId: null,
    updateTime: now,
  });

  it("hides expired notes unless asked, and marks them when shown", async () => {
    const rows = [row("shared", null), row("stale", new Date(now.getTime() - 1000), "l1")];
    const { db } = fakeDb(rows);
    expect((await listMemory(db, { projectId: "p1", now })).map((m) => m.key)).toEqual(["shared"]);
    const all = await listMemory(db, { projectId: "p1", now, includeExpired: true });
    expect(all.map((m) => [m.key, m.expired])).toEqual([
      ["shared", false],
      ["stale", true],
    ]);
  });
});
