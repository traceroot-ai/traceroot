import { describe, expect, it, vi } from "vitest";
import {
  editSignalCriteria,
  getSignal,
  listSignals,
  mergeSignals,
  moveHit,
  signalCriteriaEditSchema,
  signalsForTrace,
} from "../ee/signals/index.ts";

type SignalRow = {
  id: string;
  projectId: string;
  detectorId: string;
  criteriaVersion: number;
  mergedIntoId: string | null;
  groupKey: string | null;
  notifiedHitCount: number;
  hitCount: number;
};
type HitRow = {
  runId: string;
  signalId: string;
  projectId: string;
  detectorId: string;
  seenAt: Date;
  score?: number | null;
  criteriaVersion?: number | null;
  assignedAt?: Date;
};

const t = (m: number) => new Date(Date.UTC(2026, 8, 30, 10, m));
const signal = (over: Partial<SignalRow>): SignalRow => ({
  id: "a",
  projectId: "p",
  detectorId: "d",
  criteriaVersion: 1,
  mergedIntoId: null,
  groupKey: null,
  notifiedHitCount: 0,
  hitCount: 0,
  ...over,
});

/** In-memory signals and hits behind a transaction, logging the lock. */
type RcaRow = { signalId: string; reopenSeq: number; findingId: string; createTime: Date };

function fakeDb(signals: SignalRow[], hits: HitRow[] = [], rcas: RcaRow[] = []) {
  const log: string[] = [];
  const pick = <T extends object>(row: T | undefined) => (row ? { ...row } : null);
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      log.push(`lock:${v.join("/")}`);
      return 1;
    },
    signal: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
        pick(signals.find((s) => s.id === where.id && s.projectId === where.projectId)),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const s = signals.find((x) => x.id === where.id);
        if (!s) throw new Error("not found");
        return { ...s };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = signals.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            (s as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
          } else {
            (s as unknown as Record<string, unknown>)[k] = v;
          }
        }
        return { ...s };
      },
    },
    signalRca: {
      findMany: async ({ where }: { where: { signalId: string } }) =>
        rcas
          .filter((r) => r.signalId === where.signalId)
          .sort((a, b) => b.createTime.getTime() - a.createTime.getTime()),
      aggregate: async ({ where }: { where: { signalId: string } }) => {
        const seqs = rcas.filter((r) => r.signalId === where.signalId).map((r) => r.reopenSeq);
        return { _min: { reopenSeq: seqs.length ? Math.min(...seqs) : null } };
      },
      deleteMany: async ({ where }: { where: { signalId: string } }) => {
        for (let i = rcas.length - 1; i >= 0; i--)
          if (rcas[i].signalId === where.signalId) rcas.splice(i, 1);
        return { count: 0 };
      },
      create: async ({ data }: { data: RcaRow }) => {
        rcas.push({ ...data });
      },
    },
    signalHit: {
      findMany: async ({ where }: { where: { signalId: string } }) =>
        hits
          .filter((h) => h.signalId === where.signalId)
          .map((h) => ({ runId: h.runId, assignedAt: h.assignedAt ?? t(0) })),
      findFirst: async ({ where }: { where: { runId: string; projectId: string } }) =>
        pick(hits.find((h) => h.runId === where.runId && h.projectId === where.projectId)),
      findUniqueOrThrow: async ({ where }: { where: { runId: string } }) => {
        const h = hits.find((x) => x.runId === where.runId)!;
        return { ...h, assignedAt: h.assignedAt ?? t(0) };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { signalId: string };
        data: Partial<HitRow>;
      }) => {
        for (const h of hits.filter((x) => x.signalId === where.signalId)) Object.assign(h, data);
        return { count: 0 };
      },
      update: async ({ where, data }: { where: { runId: string }; data: Partial<HitRow> }) => {
        Object.assign(hits.find((h) => h.runId === where.runId)!, data);
      },
      aggregate: async ({ where }: { where: { signalId: string } }) => {
        const mine = hits
          .filter((h) => h.signalId === where.signalId)
          .map((h) => h.seenAt.getTime());
        return {
          _count: { _all: mine.length },
          _min: { seenAt: mine.length ? new Date(Math.min(...mine)) : null },
          _max: { seenAt: mine.length ? new Date(Math.max(...mine)) : null },
        };
      },
    },
  };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { db: db as never, log, signals, hits, rcas };
}

const edit = { title: "T", covers: "C", excludes: "", expectedCriteriaVersion: 1 };

describe("signalCriteriaEditSchema", () => {
  it("trims, requires a title and covers, and bounds the lengths", () => {
    expect(signalCriteriaEditSchema.parse({ ...edit, title: "  T  " }).title).toBe("T");
    expect(signalCriteriaEditSchema.safeParse({ ...edit, covers: " " }).success).toBe(false);
    expect(signalCriteriaEditSchema.safeParse({ ...edit, title: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(
      signalCriteriaEditSchema.safeParse({ ...edit, expectedCriteriaVersion: 0 }).success,
    ).toBe(false);
  });
});

describe("editSignalCriteria", () => {
  it("replaces the criteria under the partition lock and bumps the version", async () => {
    const f = fakeDb([signal({})]);
    expect(await editSignalCriteria(f.db, { projectId: "p", signalId: "a", edit })).toEqual({
      ok: true,
      criteriaVersion: 2,
    });
    expect(f.log).toEqual(["lock:p/d"]);
  });

  it("refuses a stale edit, a merged signal, a category signal, and another project's signal", async () => {
    const stale = fakeDb([signal({ criteriaVersion: 3 })]);
    expect(
      await editSignalCriteria(stale.db, { projectId: "p", signalId: "a", edit }),
    ).toMatchObject({ status: 409 });
    const merged = fakeDb([signal({ mergedIntoId: "b" })]);
    expect(
      await editSignalCriteria(merged.db, { projectId: "p", signalId: "a", edit }),
    ).toMatchObject({ status: 409 });
    const group = fakeDb([signal({ groupKey: "fabrication" })]);
    expect(
      await editSignalCriteria(group.db, { projectId: "p", signalId: "a", edit }),
    ).toMatchObject({ status: 400 });
    const other = fakeDb([signal({ projectId: "q" })]);
    expect(
      await editSignalCriteria(other.db, { projectId: "p", signalId: "a", edit }),
    ).toMatchObject({ status: 404 });
  });
});

describe("mergeSignals", () => {
  const later = new Date(Date.now() + 3_600_000);
  const hits = (): HitRow[] => [
    {
      runId: "r1",
      signalId: "a",
      projectId: "p",
      detectorId: "d",
      seenAt: t(1),
      score: 0.97,
      criteriaVersion: 2,
      assignedAt: later,
    },
    { runId: "r2", signalId: "a", projectId: "p", detectorId: "d", seenAt: t(9), score: 0.95 },
    { runId: "r3", signalId: "b", projectId: "p", detectorId: "d", seenAt: t(5), score: 0.99 },
  ];

  it("moves the hits, points the source at the target, and recounts the target", async () => {
    const f = fakeDb(
      [
        signal({ id: "a", hitCount: 2, notifiedHitCount: 2 }),
        signal({ id: "b", hitCount: 1, notifiedHitCount: 1 }),
      ],
      hits(),
    );
    const r = await mergeSignals(f.db, { projectId: "p", sourceId: "a", targetId: "b" });
    // Placed after every moved hit's previous assignment, even one stamped by
    // a clock ahead of this one.
    const placed = new Date(later.getTime() + 1);
    expect(r).toEqual({
      ok: true,
      moved: {
        projectId: "p",
        detectorId: "d",
        signalId: "b",
        assignedAt: placed,
        runIds: ["r1", "r2"],
      },
    });
    // Moved hits were judged against the source's criteria: no score or version.
    expect(f.hits.filter((h) => h.runId !== "r3")).toEqual([
      expect.objectContaining({ score: null, criteriaVersion: null, assignedAt: placed }),
      expect.objectContaining({ score: null, criteriaVersion: null, assignedAt: placed }),
    ]);
    expect(f.hits[2]).toMatchObject({ score: 0.99 });
    const [a, b] = f.signals;
    expect(a).toMatchObject({ mergedIntoId: "b", hitCount: 0 });
    // Hits already reported for the source are not reported again as new.
    expect(b).toMatchObject({ hitCount: 3, notifiedHitCount: 3 });
    expect((b as unknown as { firstSeenAt: Date }).firstSeenAt).toEqual(t(1));
    expect(f.hits.every((h) => h.signalId === "b")).toBe(true);
    expect(f.log).toEqual(["lock:p/d"]);
  });

  it("carries the source's RCAs over, numbered below the target's own openings", async () => {
    const rcas: RcaRow[] = [
      { signalId: "a", reopenSeq: 0, findingId: "fa0", createTime: t(1) },
      { signalId: "a", reopenSeq: 1, findingId: "fa1", createTime: t(8) },
      { signalId: "b", reopenSeq: 0, findingId: "fb0", createTime: t(2) },
      { signalId: "b", reopenSeq: -1, findingId: "old", createTime: t(0) },
    ];
    const f = fakeDb([signal({ id: "a" }), signal({ id: "b" })], hits(), rcas);
    await mergeSignals(f.db, { projectId: "p", sourceId: "a", targetId: "b" });
    const onB = f.rcas.filter((r) => r.signalId === "b").map((r) => [r.reopenSeq, r.findingId]);
    expect(onB).toEqual([
      [0, "fb0"],
      [-1, "old"],
      [-2, "fa1"],
      [-3, "fa0"],
    ]);
    expect(f.rcas.some((r) => r.signalId === "a")).toBe(false);
  });

  it("refuses merging into itself, across detectors, or an already merged signal", async () => {
    const self = fakeDb([signal({})]);
    expect(
      await mergeSignals(self.db, { projectId: "p", sourceId: "a", targetId: "a" }),
    ).toMatchObject({ status: 400 });
    const across = fakeDb([signal({ id: "a" }), signal({ id: "b", detectorId: "other" })]);
    expect(
      await mergeSignals(across.db, { projectId: "p", sourceId: "a", targetId: "b" }),
    ).toMatchObject({ status: 400 });
    const done = fakeDb([signal({ id: "a", mergedIntoId: "c" }), signal({ id: "b" })]);
    expect(
      await mergeSignals(done.db, { projectId: "p", sourceId: "a", targetId: "b" }),
    ).toMatchObject({ status: 409 });
    const missing = fakeDb([signal({ id: "a" })]);
    expect(
      await mergeSignals(missing.db, { projectId: "p", sourceId: "a", targetId: "b" }),
    ).toMatchObject({ status: 404 });
  });
});

describe("moveHit", () => {
  it("moves one hit and recounts both signals", async () => {
    const f = fakeDb(
      [signal({ id: "a", hitCount: 2 }), signal({ id: "b", hitCount: 0 })],
      [
        { runId: "r1", signalId: "a", projectId: "p", detectorId: "d", seenAt: t(1) },
        {
          runId: "r2",
          signalId: "a",
          projectId: "p",
          detectorId: "d",
          seenAt: t(2),
          score: 0.96,
          criteriaVersion: 1,
        },
      ],
    );
    const before = Date.now();
    const r = await moveHit(f.db, { projectId: "p", runId: "r2", targetId: "b" });
    expect(r).toMatchObject({
      ok: true,
      moved: { projectId: "p", detectorId: "d", signalId: "b", runIds: ["r2"] },
    });
    const placed = (r as { moved: { assignedAt: Date } }).moved.assignedAt;
    expect(placed.getTime()).toBeGreaterThanOrEqual(before);
    expect(f.hits[1]).toMatchObject({ score: null, criteriaVersion: null, assignedAt: placed });
    expect(f.signals.map((s) => s.hitCount)).toEqual([1, 1]);
  });

  it("moves an already reported hit's report with it", async () => {
    const hits = (): HitRow[] => [
      { runId: "r1", signalId: "a", projectId: "p", detectorId: "d", seenAt: t(1) },
      { runId: "r2", signalId: "a", projectId: "p", detectorId: "d", seenAt: t(2) },
      { runId: "r3", signalId: "b", projectId: "p", detectorId: "d", seenAt: t(3) },
    ];
    // Both of a's hits were reported: a keeps 1 of 1, b now counts r2 as reported.
    const reported = fakeDb(
      [
        signal({ id: "a", hitCount: 2, notifiedHitCount: 2 }),
        signal({ id: "b", hitCount: 1, notifiedHitCount: 1 }),
      ],
      hits(),
    );
    await moveHit(reported.db, { projectId: "p", runId: "r2", targetId: "b" });
    expect(reported.signals.map((s) => [s.hitCount, s.notifiedHitCount])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    // a had one unreported hit: it stays unreported, now under b.
    const unreported = fakeDb(
      [
        signal({ id: "a", hitCount: 2, notifiedHitCount: 1 }),
        signal({ id: "b", hitCount: 1, notifiedHitCount: 1 }),
      ],
      hits(),
    );
    await moveHit(unreported.db, { projectId: "p", runId: "r2", targetId: "b" });
    expect(unreported.signals.map((s) => [s.hitCount, s.notifiedHitCount])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("is a no-op when the hit is already there, and refuses other detectors and missing hits", async () => {
    const rows = [signal({ id: "a" }), signal({ id: "b", detectorId: "other" })];
    const hit = [{ runId: "r1", signalId: "a", projectId: "p", detectorId: "d", seenAt: t(1) }];
    const here = fakeDb([signal({ id: "a" })], [...hit]);
    expect(await moveHit(here.db, { projectId: "p", runId: "r1", targetId: "a" })).toMatchObject({
      ok: true,
      moved: { runIds: [] },
    });
    const across = fakeDb(rows, [...hit]);
    expect(await moveHit(across.db, { projectId: "p", runId: "r1", targetId: "b" })).toMatchObject({
      status: 400,
    });
    const none = fakeDb(rows, []);
    expect(await moveHit(none.db, { projectId: "p", runId: "r1", targetId: "a" })).toMatchObject({
      status: 404,
    });
    const noTarget = fakeDb([signal({ id: "a" })], [...hit]);
    expect(
      await moveHit(noTarget.db, { projectId: "p", runId: "r1", targetId: "zz" }),
    ).toMatchObject({ status: 404 });
    const merged = fakeDb([signal({ id: "a" }), signal({ id: "b", mergedIntoId: "a" })], [...hit]);
    expect(await moveHit(merged.db, { projectId: "p", runId: "r1", targetId: "b" })).toMatchObject({
      status: 409,
    });
  });
});

describe("reads", () => {
  const rca = (reopenSeq: number, status: string, result: string | null = null) => ({
    reopenSeq,
    findingId: `f${reopenSeq}`,
    createTime: t(reopenSeq),
    rca: { status, result, completedAt: status === "done" ? t(reopenSeq) : null },
  });

  it("lists a detector's signals with the state of their RCAs", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "a",
        title: "A",
        status: "open",
        reopenSeq: 1,
        hitCount: 3,
        rcas: [rca(0, "done"), rca(1, "running")],
      },
    ]);
    const count = vi.fn(async () => 120);
    const list = await listSignals({ signal: { findMany, count } } as never, {
      projectId: "p",
      detectorId: "d",
      status: "open",
      page: 2,
      limit: 50,
    });
    expect(list.total).toBe(120);
    expect(list.signals[0].rca).toEqual({ currentState: "running", canonicalFindingId: "f0" });
    const where = { projectId: "p", detectorId: "d", mergedIntoId: null, status: "open" };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 100, take: 50 }));
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("returns a signal with its canonical RCA, hits and status history", async () => {
    const db = {
      signal: {
        findFirst: vi.fn(async () => ({
          id: "a",
          title: "A",
          reopenSeq: 2,
          mergedIntoId: null,
          rcas: [rca(2, "failed"), rca(1, "done", "cause one"), rca(0, "done", "cause zero")],
        })),
      },
      signalHit: { findMany: vi.fn(async () => [{ runId: "r1" }]) },
      signalStatusEvent: { findMany: vi.fn(async () => [{ toStatus: "open", reason: "new_hit" }]) },
    };
    const r = await getSignal(db as never, { projectId: "p", signalId: "a" });
    expect(db.signal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a", projectId: "p" } }),
    );
    expect(r).toMatchObject({
      merged: false,
      signal: {
        rca: { currentState: "failed", canonicalFindingId: "f1" },
        canonicalRca: { findingId: "f1", reopenSeq: 1, result: "cause one" },
      },
      hits: [{ runId: "r1" }],
      statusEvents: [{ reason: "new_hit" }],
    });
    expect((r as { signal: { rcaHistory: unknown[] } }).signal.rcaHistory).toHaveLength(3);
  });

  it("points at the target of a merged signal, and is null for a missing one", async () => {
    const merged = {
      signal: { findFirst: vi.fn(async () => ({ id: "a", mergedIntoId: "b", rcas: [] })) },
    };
    expect(await getSignal(merged as never, { projectId: "p", signalId: "a" })).toEqual({
      merged: true,
      mergedIntoId: "b",
    });
    const none = { signal: { findFirst: vi.fn(async () => null) } };
    expect(await getSignal(none as never, { projectId: "p", signalId: "a" })).toBe(null);
  });

  it("maps a trace's hits to their signals", async () => {
    const db = {
      signalHit: {
        findMany: vi.fn(async () => [
          {
            runId: "r1",
            detectorId: "d",
            findingId: "f",
            signal: { id: "a", title: "A", status: "open" },
          },
        ]),
      },
    };
    const rows = await signalsForTrace(db as never, { projectId: "p", traceId: "t" });
    expect(db.signalHit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p", traceId: "t" } }),
    );
    expect(rows).toEqual([
      {
        runId: "r1",
        detectorId: "d",
        findingId: "f",
        signalId: "a",
        signalTitle: "A",
        signalStatus: "open",
      },
    ]);
  });
});
