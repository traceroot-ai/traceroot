import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { allocateExecution, advanceLatest, executionTraceId } from "../rca-executions.ts";

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

function fakeDb(
  existingAttempts: number[],
  latest: { executionId: string; attempt: number } | null,
) {
  const created: any[] = [];
  const updates: any[] = [];
  const db = {
    $transaction: async (fn: any) => fn(db),
    $queryRaw: vi.fn(async () => [{ id: "rca-row" }]), // row lock
    detectorRcaExecution: {
      aggregate: vi.fn(async () => ({
        _max: { attempt: existingAttempts.length ? Math.max(...existingAttempts) : null },
      })),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `exec-${data.attempt}`, ...data };
        created.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => ({ attempt: Number(where.id.split("-")[1]) })),
    },
    detectorRca: {
      findUnique: vi.fn(async () =>
        latest
          ? { latestExecutionId: latest.executionId, latestExecution: { attempt: latest.attempt } }
          : { latestExecutionId: null, latestExecution: null },
      ),
      updateMany: vi.fn(async ({ where }: any) => {
        updates.push(where);
        return { count: where.latestExecutionId === (latest?.executionId ?? null) ? 1 : 0 };
      }),
    },
  };
  return { db, created, updates };
}

describe("allocateExecution", () => {
  it("seeds attempt 1 from a legacy RCA row (no executions yet, RCA already done) and allocates attempt 2", async () => {
    const { db, created } = fakeDb([], null);
    db.detectorRca.findUnique = vi.fn(async () => ({
      latestExecutionId: null,
      latestExecution: null,
      status: "done",
      sessionId: "s-old",
      result: "old answer",
      createTime: new Date(0),
      completedAt: new Date(1),
    }));
    const r = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(created[0]).toMatchObject({
      attempt: 1,
      traceStatus: "disabled",
      sessionId: "s-old",
      result: "old answer",
      traceId: executionTraceId("f-1", 1),
    });
    expect(r.attempt).toBe(2);
  });
  it("first allocation is attempt 1 with the finding-derived trace id", async () => {
    const { db, created } = fakeDb([], null);
    const r = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(r.attempt).toBe(1);
    expect(r.traceId).toBe(executionTraceId("f-1", 1));
    expect(created[0].traceStatus).toBe("pending");
  });
  it("second allocation is attempt 2 with a different trace id", async () => {
    const { db } = fakeDb([1], { executionId: "exec-1", attempt: 1 });
    const r = await allocateExecution(db as any, { findingId: "f-1", projectId: "p-1" });
    expect(r.attempt).toBe(2);
    expect(r.traceId).not.toBe(executionTraceId("f-1", 1));
  });
});

describe("advanceLatest (compare-and-set on attempt)", () => {
  it("moves the pointer forward", async () => {
    const { db } = fakeDb([1], { executionId: "exec-1", attempt: 1 });
    expect(
      await advanceLatest(db as any, { findingId: "f-1", executionId: "exec-2", attempt: 2 }),
    ).toBe(true);
  });
  it("does not move the pointer backwards when an older run finishes last", async () => {
    const { db } = fakeDb([1, 2], { executionId: "exec-2", attempt: 2 });
    expect(
      await advanceLatest(db as any, { findingId: "f-1", executionId: "exec-1", attempt: 1 }),
    ).toBe(false);
  });
});
