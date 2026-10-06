import { describe, expect, it, vi } from "vitest";
import {
  DISMISS_REASONS,
  RESOLVE_REASONS,
  SIGNAL_NOTE_MAX_LENGTH,
  hitReopensSignal,
  lockSignalPartition,
  pickCanonicalRca,
  reopenSignalForHit,
  setSignalStatus,
  signalAssignJobId,
  signalStatusChangeSchema,
  type SignalStatusChange,
} from "../ee/signals/index.ts";

describe("signalStatusChangeSchema", () => {
  const parse = (v: unknown) => signalStatusChangeSchema.safeParse(v);

  it("accepts every resolve and dismiss reason with no note except other", () => {
    for (const reason of RESOLVE_REASONS.filter((r) => r !== "other")) {
      expect(parse({ status: "resolved", reason }).success).toBe(true);
    }
    for (const reason of DISMISS_REASONS.filter((r) => r !== "other")) {
      expect(parse({ status: "dismissed", reason }).success).toBe(true);
    }
  });

  it("requires a reason to resolve or dismiss", () => {
    expect(parse({ status: "resolved" }).success).toBe(false);
    expect(parse({ status: "dismissed", note: "n" }).success).toBe(false);
  });

  it("rejects a reason from the other list", () => {
    expect(parse({ status: "resolved", reason: "not_a_problem" }).success).toBe(false);
    expect(parse({ status: "dismissed", reason: "fixed_by_pr" }).success).toBe(false);
  });

  it('requires a non-blank note when the reason is "other"', () => {
    expect(parse({ status: "resolved", reason: "other" }).success).toBe(false);
    expect(parse({ status: "dismissed", reason: "other", note: "   " }).success).toBe(false);
    const ok = parse({ status: "dismissed", reason: "other", note: "  duplicate of a known bug " });
    expect(ok.success && ok.data).toEqual({
      status: "dismissed",
      reason: "other",
      note: "duplicate of a known bug",
    });
  });

  it("stores a blank note as null and caps the note length", () => {
    const blank = parse({ status: "resolved", reason: "fixed_by_pr", note: "" });
    expect(blank.success && blank.data.note).toBe(null);
    const max = "x".repeat(SIGNAL_NOTE_MAX_LENGTH);
    expect(parse({ status: "resolved", reason: "fixed_by_pr", note: max }).success).toBe(true);
    expect(parse({ status: "resolved", reason: "fixed_by_pr", note: `${max}x` }).success).toBe(
      false,
    );
  });

  it("reopens with no reason", () => {
    const r = parse({ status: "open" });
    expect(r.success && r.data).toEqual({ status: "open", note: null });
    expect(parse({ status: "merged" }).success).toBe(false);
  });
});

type Row = {
  id: string;
  projectId: string;
  detectorId: string;
  status: string;
  mergedIntoId: string | null;
  resolvedAt: Date | null;
};

/**
 * A fake db over one signals list. Statements must run on the `tx` handed out by
 * `$transaction`; `order` records the sequence so tests can check the status is
 * re-read only after the partition lock is taken. `onLock` stands in for a
 * concurrent writer that committed just before the lock was granted.
 */
function fakeDb(rows: Row[], opts: { onLock?: () => void } = {}) {
  const order: string[] = [];
  const events: Record<string, unknown>[] = [];
  const lockArgs: unknown[][] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push("lock");
      lockArgs.push(values);
      expect(strings.join("?")).toContain("pg_advisory_xact_lock");
      opts.onLock?.();
      return 1;
    }),
    signal: {
      findFirst: vi.fn(async ({ where }: any) => {
        order.push("find");
        const r = rows.find((x) => x.id === where.id && x.projectId === where.projectId);
        return r ? { detectorId: r.detectorId } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        order.push("read");
        const r = rows.find((x) => x.id === where.id)!;
        return { status: r.status, mergedIntoId: r.mergedIntoId };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        order.push("update");
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, { status: data.status, resolvedAt: data.resolvedAt });
        return r;
      }),
    },
    signalStatusEvent: {
      create: vi.fn(async ({ data }: any) => {
        order.push("event");
        events.push(data);
        return data;
      }),
    },
  };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { db: db as any, order, events, lockArgs };
}

const signal = (over: Partial<Row> = {}): Row => ({
  id: "sig1",
  projectId: "proj1",
  detectorId: "det1",
  status: "open",
  mergedIntoId: null,
  resolvedAt: null,
  ...over,
});

const resolve: SignalStatusChange = { status: "resolved", reason: "fixed_by_pr", note: "PR 42" };

describe("setSignalStatus", () => {
  it("resolves under the partition lock and records who, what and why", async () => {
    const rows = [signal()];
    const { db, order, events, lockArgs } = fakeDb(rows);
    const res = await setSignalStatus(db, {
      projectId: "proj1",
      signalId: "sig1",
      actorUserId: "user1",
      change: resolve,
      expectedStatus: "open",
    });
    expect(res).toEqual({ ok: true, changed: true, status: "resolved" });
    expect(order).toEqual(["find", "lock", "read", "update", "event"]);
    expect(lockArgs[0]).toEqual(["proj1", "det1"]);
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].resolvedAt).toBeInstanceOf(Date);
    expect(events).toEqual([
      {
        signalId: "sig1",
        actorUserId: "user1",
        fromStatus: "open",
        toStatus: "resolved",
        reason: "fixed_by_pr",
        note: "PR 42",
      },
    ]);
  });

  it("clears resolvedAt and records no reason when a user reopens", async () => {
    const rows = [signal({ status: "resolved", resolvedAt: new Date("2026-09-01") })];
    const { db, events } = fakeDb(rows);
    const res = await setSignalStatus(db, {
      projectId: "proj1",
      signalId: "sig1",
      actorUserId: "user1",
      change: { status: "open", note: null },
    });
    expect(res).toEqual({ ok: true, changed: true, status: "open" });
    expect(rows[0].resolvedAt).toBe(null);
    expect(events[0]).toMatchObject({ fromStatus: "resolved", toStatus: "open", reason: null });
  });

  it("does not find a signal from another project", async () => {
    const { db, order } = fakeDb([signal()]);
    const res = await setSignalStatus(db, {
      projectId: "other",
      signalId: "sig1",
      actorUserId: "user1",
      change: resolve,
    });
    expect(res).toEqual({ ok: false, code: "not_found" });
    expect(order).toEqual(["find"]);
  });

  it("decides on the status read under the lock, not before it", async () => {
    // A new hit reopens nothing here, but another user dismisses the signal
    // between our first read and the lock grant.
    const rows = [signal()];
    const { db, events } = fakeDb(rows, { onLock: () => (rows[0].status = "dismissed") });
    const res = await setSignalStatus(db, {
      projectId: "proj1",
      signalId: "sig1",
      actorUserId: "user1",
      change: resolve,
      expectedStatus: "open",
    });
    expect(res).toEqual({ ok: false, code: "conflict", status: "dismissed" });
    expect(events).toEqual([]);
  });

  it("writes nothing when the status is already the target", async () => {
    const { db, events } = fakeDb([signal({ status: "resolved" })]);
    const res = await setSignalStatus(db, {
      projectId: "proj1",
      signalId: "sig1",
      actorUserId: "user1",
      change: resolve,
    });
    expect(res).toEqual({ ok: true, changed: false, status: "resolved" });
    expect(events).toEqual([]);
  });

  it("refuses a merged signal and points at its target", async () => {
    const { db, events } = fakeDb([signal({ mergedIntoId: "sig2" })]);
    const res = await setSignalStatus(db, {
      projectId: "proj1",
      signalId: "sig1",
      actorUserId: "user1",
      change: resolve,
    });
    expect(res).toEqual({ ok: false, code: "merged", mergedIntoId: "sig2" });
    expect(events).toEqual([]);
  });
});

describe("hitReopensSignal", () => {
  const resolvedAt = new Date("2026-09-30T10:00:00Z");
  it("reopens a resolved signal for a trace that started after the resolve", () => {
    expect(
      hitReopensSignal({ status: "resolved", resolvedAt }, new Date("2026-09-30T10:00:01Z")),
    ).toBe(true);
  });
  it("does not reopen for a trace already running at resolve time", () => {
    expect(hitReopensSignal({ status: "resolved", resolvedAt }, resolvedAt)).toBe(false);
    expect(
      hitReopensSignal({ status: "resolved", resolvedAt }, new Date("2026-09-30T09:59:00Z")),
    ).toBe(false);
  });
  it("never reopens an open or dismissed signal", () => {
    const later = new Date("2026-10-01T00:00:00Z");
    expect(hitReopensSignal({ status: "dismissed", resolvedAt: null }, later)).toBe(false);
    expect(hitReopensSignal({ status: "open", resolvedAt: null }, later)).toBe(false);
    expect(hitReopensSignal({ status: "resolved", resolvedAt: null }, later)).toBe(false);
  });
});

describe("reopenSignalForHit", () => {
  it("bumps reopenSeq and records the system as the actor", async () => {
    const events: unknown[] = [];
    const tx = {
      signal: {
        update: vi.fn(async ({ data }: any) => {
          expect(data).toEqual({ status: "open", resolvedAt: null, reopenSeq: { increment: 1 } });
          return { reopenSeq: 3 };
        }),
      },
      signalStatusEvent: { create: vi.fn(async ({ data }: any) => events.push(data)) },
    };
    await expect(reopenSignalForHit(tx as any, "sig1")).resolves.toBe(3);
    expect(events).toEqual([
      {
        signalId: "sig1",
        actorUserId: "system",
        fromStatus: "resolved",
        toStatus: "open",
        reason: "new_hit",
        note: null,
      },
    ]);
  });
});

describe("pickCanonicalRca", () => {
  const row = (reopenSeq: number, result: string | null) => ({ reopenSeq, result });
  it("takes the newest opening that kept a successful answer, whatever finished last", () => {
    expect(pickCanonicalRca([row(2, "c"), row(0, "a"), row(1, "b")])).toEqual(row(2, "c"));
  });
  it("falls back to an older answer while the newest opening has none yet", () => {
    expect(pickCanonicalRca([row(0, "a"), row(1, null), row(2, null)])).toEqual(row(0, "a"));
  });
  it("is null until some opening kept an answer", () => {
    expect(pickCanonicalRca([row(0, null)])).toBe(null);
    expect(pickCanonicalRca([])).toBe(null);
  });
});

describe("partition keys", () => {
  it("builds a BullMQ-valid job id with exactly three parts", () => {
    const id = signalAssignJobId("proj1", "cm1abc");
    expect(id).toBe("assign:proj1:cm1abc");
    expect(id.split(":")).toHaveLength(3);
  });
  it("rejects ids that would break the job id", () => {
    expect(() => signalAssignJobId("p:1", "d")).toThrow();
    expect(() => signalAssignJobId("p", "")).toThrow();
  });
  it("locks on the project and detector", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const tx = {
      $executeRaw: vi.fn(async (s: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: s.join("?"), values });
        return 1;
      }),
    };
    await lockSignalPartition(tx as any, "proj1", "det1");
    expect(calls[0].text).toContain("pg_advisory_xact_lock(hashtext('signals')");
    expect(calls[0].values).toEqual(["proj1", "det1"]);
  });
});
