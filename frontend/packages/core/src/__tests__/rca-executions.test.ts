import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { allocateExecution, executionTraceId, finishFindingIfLatest } from "../rca-executions.ts";

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
 */
function fakeDb(executions: Execution[] = []) {
  const sql: { text: string; values: unknown[] }[] = [];
  const db = {
    $transaction: async (fn: any) => fn(db),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ text: strings.join("?"), values });
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
  return { db, executions, sql };
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
    const { db, sql } = fakeDb();
    await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(sql[0].text).toMatch(/FROM detector_rcas WHERE finding_id = \? FOR UPDATE/);
    expect(sql[0].values).toEqual(["f-1"]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.detectorRcaExecution.aggregate.mock.invocationCallOrder[0],
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

  it("is a single conditional UPDATE guarded by NOT EXISTS on a higher attempt", async () => {
    const { db, sql } = fakeDb([exec(1)]);
    const completedAt = new Date(5);
    await finishFindingIfLatest(db as any, {
      findingId: "f-1",
      attempt: 1,
      status: "done",
      result: "answer",
      completedAt,
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const text = sql[0].text.replace(/\s+/g, " ");
    expect(text).toContain("UPDATE detector_rcas SET status = ?, result = ?, completed_at = ?");
    expect(text).toContain(
      "WHERE finding_id = ? AND NOT EXISTS ( SELECT 1 FROM detector_rca_executions WHERE finding_id = ? AND attempt > ? )",
    );
    expect(sql[0].values).toEqual(["done", "answer", completedAt, "f-1", "f-1", 1]);
  });

  it("defaults result to null and completedAt to now", async () => {
    const { db, sql } = fakeDb([exec(1)]);
    const before = Date.now();
    await finishFindingIfLatest(db as any, { findingId: "f-1", attempt: 1, status: "failed" });
    const [, result, completedAt] = sql[0].values as [string, unknown, Date];
    expect(result).toBeNull();
    expect(completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
