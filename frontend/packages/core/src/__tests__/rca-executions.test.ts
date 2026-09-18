import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  allocateExecution,
  executionTraceId,
  finishFindingIfLatest,
  markFindingRunningIfLatest,
} from "../rca-executions.ts";

describe("executionTraceId", () => {
  it("attempt 1 is the dashless finding id", () => {
    expect(executionTraceId("3817f98c-1876-6de9-30a2-66452c8e1e9f", 1)).toBe(
      "3817f98c18766de930a266452c8e1e9f",
    );
  });
  it("attempt n>=2 is sha256(finding:n)[:32]", () => {
    const expected = createHash("sha256")
      .update("3817f98c-1876-6de9-30a2-66452c8e1e9f:2")
      .digest("hex")
      .slice(0, 32);
    expect(executionTraceId("3817f98c-1876-6de9-30a2-66452c8e1e9f", 2)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });
});

type Execution = { id: string; findingId: string; attempt: number; traceId: string };

/**
 * A fake db backed by a real executions list: `aggregate` reflects prior
 * `create`s and `create` enforces uq_rca_execution_finding_attempt, so the
 * allocator's "next attempt" logic is exercised against real state rather than
 * canned answers. `$executeRaw` evaluates finishFindingIfLatest's NOT EXISTS
 * predicate against the same list.
 *
 * Every statement must run on the `tx` client handed out by `$transaction`;
 * the top-level client refuses raw SQL so a call outside the transaction (and
 * therefore outside the finding's row lock) fails the test. `onLock` runs when
 * the `FOR UPDATE` statement executes, standing in for a concurrent transaction
 * that committed just before the lock was granted.
 */
function fakeDb(executions: Execution[] = [], opts: { onLock?: () => void } = {}) {
  const sql: { text: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      sql.push({ text, values });
      if (/FOR UPDATE/.test(text)) opts.onLock?.();
      return [{ id: "rca-row" }];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      sql.push({ text, values });
      // Params, in template order: status, result, completed_at, finding_id, finding_id, attempt.
      const [, , , findingId, , attempt] = values as [
        string,
        string | null,
        Date,
        string,
        string,
        number,
      ];
      const higher = executions.some((e) => e.findingId === findingId && e.attempt > attempt);
      return higher ? 0 : 1;
    }),
    detectorRcaExecution: {
      aggregate: vi.fn(async ({ where }: any) => {
        const attempts = executions
          .filter((e) => e.findingId === where.findingId)
          .map((e) => e.attempt);
        return { _max: { attempt: attempts.length ? Math.max(...attempts) : null } };
      }),
      create: vi.fn(async ({ data }: any) => {
        if (executions.some((e) => e.findingId === data.findingId && e.attempt === data.attempt)) {
          throw new Error("P2002: uq_rca_execution_finding_attempt");
        }
        const row = { id: `exec-${data.attempt}`, ...data };
        executions.push(row);
        return row;
      }),
    },
  };
  const outsideTransaction = () => {
    throw new Error("raw SQL must run inside $transaction");
  };
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    $queryRaw: vi.fn(outsideTransaction),
    $executeRaw: vi.fn(outsideTransaction),
    detectorRcaExecution: tx.detectorRcaExecution,
  };
  return { db, tx, executions, sql };
}

describe("allocateExecution", () => {
  it("first allocation is attempt 1 with the finding-derived trace id", async () => {
    const { db, executions } = fakeDb();
    const r = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(r.attempt).toBe(1);
    expect(r.traceId).toBe(executionTraceId("f-1", 1));
    expect(executions[0]).toMatchObject({ attempt: 1, traceStatus: "pending", projectId: "p-1" });
  });

  it("consecutive allocations get n, n+1 and distinct trace ids without violating (finding, attempt)", async () => {
    const { db, executions } = fakeDb();
    const a = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    const b = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect([a.attempt, b.attempt]).toEqual([1, 2]);
    expect(b.traceId).not.toBe(a.traceId);
    expect(executions.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("takes the finding's row lock before reading the max attempt", async () => {
    const { db, tx, sql } = fakeDb();
    await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(sql[0].text).toMatch(/FROM detector_rcas WHERE finding_id = \? FOR UPDATE/);
    expect(sql[0].values).toEqual(["f-1"]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.detectorRcaExecution.aggregate.mock.invocationCallOrder[0],
    );
  });

  it("does not seed a synthetic attempt for a legacy finding: its first execution is attempt 1", async () => {
    const { db, executions } = fakeDb();
    const r = await allocateExecution(db as any, { findingId: "f-old", projectId: "p-1" });
    expect(r.attempt).toBe(1);
    expect(executions).toHaveLength(1);
  });
});

describe("finishFindingIfLatest", () => {
  const exec = (attempt: number): Execution => ({
    id: `exec-${attempt}`,
    findingId: "f-1",
    attempt,
    traceId: executionTraceId("f-1", attempt),
  });

  it("writes when no higher attempt exists", async () => {
    const { db } = fakeDb([exec(1), exec(2)]);
    expect(
      await finishFindingIfLatest(db as any, {
        findingId: "f-1",
        attempt: 2,
        status: "done",
        result: "answer",
      }),
    ).toBe(true);
  });

  it("does not write when a higher attempt exists (older run finishing last)", async () => {
    const { db } = fakeDb([exec(1), exec(2)]);
    expect(
      await finishFindingIfLatest(db as any, {
        findingId: "f-1",
        attempt: 1,
        status: "failed",
        result: "RCA failed: timeout",
      }),
    ).toBe(false);
  });

  it("takes the finding's row lock (the one allocateExecution takes) before the guarded UPDATE, in one transaction", async () => {
    const { db, tx, sql } = fakeDb([exec(1)]);
    await finishFindingIfLatest(db as any, { findingId: "f-1", attempt: 1, status: "done" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(sql.map((s) => s.text)).toEqual([
      expect.stringMatching(/^SELECT id FROM detector_rcas WHERE finding_id = \? FOR UPDATE$/),
      expect.stringMatching(/UPDATE detector_rcas/),
    ]);
    expect(sql[0].values).toEqual(["f-1"]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
  });

  it("sees a retry that was allocated while it waited for the lock, and yields to it", async () => {
    // Attempt 2 does not exist when the finish starts; it is committed by the
    // allocation holding the lock, i.e. it becomes visible exactly when the
    // lock is granted. A guard evaluated before the lock would have passed.
    const executions = [exec(1)];
    const { db } = fakeDb(executions, { onLock: () => executions.push(exec(2)) });
    expect(
      await finishFindingIfLatest(db as any, {
        findingId: "f-1",
        attempt: 1,
        status: "done",
        result: "stale answer",
      }),
    ).toBe(false);
  });

  it("is a single conditional UPDATE guarded by NOT EXISTS on a higher attempt", async () => {
    const { db, tx, sql } = fakeDb([exec(1)]);
    const completedAt = new Date(5);
    await finishFindingIfLatest(db as any, {
      findingId: "f-1",
      attempt: 1,
      status: "done",
      result: "answer",
      completedAt,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const update = sql[1];
    const text = update.text.replace(/\s+/g, " ");
    expect(text).toContain("UPDATE detector_rcas SET status = ?, result = ?, completed_at = ?");
    expect(text).toContain(
      "WHERE finding_id = ? AND NOT EXISTS ( SELECT 1 FROM detector_rca_executions WHERE finding_id = ? AND attempt > ? )",
    );
    expect(update.values).toEqual(["done", "answer", completedAt, "f-1", "f-1", 1]);
  });

  it("defaults result to null and completedAt to now", async () => {
    const { db, sql } = fakeDb([exec(1)]);
    const before = Date.now();
    await finishFindingIfLatest(db as any, { findingId: "f-1", attempt: 1, status: "failed" });
    const [, result, completedAt] = sql[1].values as [string, unknown, Date];
    expect(result).toBeNull();
    expect(completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("markFindingRunningIfLatest", () => {
  const exec = (attempt: number): Execution => ({
    id: `exec-${attempt}`,
    findingId: "f-1",
    attempt,
    traceId: executionTraceId("f-1", attempt),
  });

  /** updateMany evaluated against the executions list the way Postgres evaluates `none`. */
  function fakeUpdateMany(executions: Execution[]) {
    return vi.fn(async ({ where }: any) => {
      const gt = where.executions.none.attempt.gt;
      const higher = executions.some((e) => e.findingId === where.findingId && e.attempt > gt);
      return { count: higher ? 0 : 1 };
    });
  }

  it("marks the finding running when this attempt is the highest", async () => {
    const updateMany = fakeUpdateMany([exec(1), exec(2)]);
    const db = { detectorRca: { updateMany } };
    expect(
      await markFindingRunningIfLatest(db as any, {
        findingId: "f-1",
        projectId: "p-1",
        attempt: 2,
      }),
    ).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { findingId: "f-1", executions: { none: { attempt: { gt: 2 } } } },
      data: { status: "running", projectId: "p-1" },
    });
  });

  it("leaves the finding alone when a newer attempt exists (redelivered stale job)", async () => {
    const updateMany = fakeUpdateMany([exec(1), exec(2)]);
    const db = { detectorRca: { updateMany } };
    expect(
      await markFindingRunningIfLatest(db as any, {
        findingId: "f-1",
        projectId: "p-1",
        attempt: 1,
      }),
    ).toBe(false);
  });
});
