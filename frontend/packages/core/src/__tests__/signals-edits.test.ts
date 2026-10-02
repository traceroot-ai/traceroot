import { describe, expect, it, vi } from "vitest";
import {
  editSignalCriteria,
  getSignal,
  listSignals,
  mergeSignals,
  moveHit,
  signalCriteriaEditSchema,
  signalsForTrace,
  detectorSignalSettings,
  signalSetup,
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
  reportedAt?: Date | null;
  copyPending?: boolean;
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
type RcaRow = {
  signalId: string;
  reopenSeq: number;
  findingId: string;
  createTime: Date;
  result?: string | null;
  rootCause?: string | null;
  sessionId?: string | null;
};

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
          .map((h) => ({ runId: h.runId, assignedAt: h.assignedAt ?? new Date(0) })),
      findFirst: async ({ where }: { where: { runId: string; projectId: string } }) =>
        pick(hits.find((h) => h.runId === where.runId && h.projectId === where.projectId)),
      findUniqueOrThrow: async ({ where }: { where: { runId: string } }) => {
        const h = hits.find((x) => x.runId === where.runId)!;
        return { ...h, assignedAt: h.assignedAt ?? new Date(0) };
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
          _count: {
            _all: mine.length,
            reportedAt: hits.filter((h) => h.signalId === where.signalId && h.reportedAt != null)
              .length,
          },
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
      reportedAt: t(0),
      score: 0.97,
      criteriaVersion: 2,
      assignedAt: later,
    },
    {
      runId: "r2",
      signalId: "a",
      projectId: "p",
      detectorId: "d",
      seenAt: t(9),
      reportedAt: t(0),
      score: 0.95,
    },
    {
      runId: "r3",
      signalId: "b",
      projectId: "p",
      detectorId: "d",
      seenAt: t(5),
      reportedAt: t(0),
      score: 0.99,
    },
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
      {
        signalId: "a",
        reopenSeq: 1,
        findingId: "fa1",
        createTime: t(8),
        result: "kept answer",
        rootCause: "kept cause",
        sessionId: "sess",
      },
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
    // A carried opening keeps its last successful answer.
    expect(f.rcas.find((r) => r.findingId === "fa1")).toMatchObject({
      signalId: "b",
      result: "kept answer",
      rootCause: "kept cause",
      sessionId: "sess",
    });
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
      {
        runId: "r1",
        signalId: "a",
        projectId: "p",
        detectorId: "d",
        seenAt: t(1),
        reportedAt: t(0),
      },
      {
        runId: "r2",
        signalId: "a",
        projectId: "p",
        detectorId: "d",
        seenAt: t(2),
        reportedAt: t(0),
      },
      {
        runId: "r3",
        signalId: "b",
        projectId: "p",
        detectorId: "d",
        seenAt: t(3),
        reportedAt: t(0),
      },
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
      hits().map((h) => (h.runId === "r2" ? { ...h, reportedAt: null } : h)),
    );
    await moveHit(unreported.db, { projectId: "p", runId: "r2", targetId: "b" });
    expect(unreported.signals.map((s) => [s.hitCount, s.notifiedHitCount])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("moving the old reported hit leaves the newer source hit unreported", async () => {
    const f = fakeDb(
      [signal({ id: "a", hitCount: 2, notifiedHitCount: 1 }), signal({ id: "b" })],
      [
        {
          runId: "old",
          signalId: "a",
          projectId: "p",
          detectorId: "d",
          seenAt: t(1),
          reportedAt: t(2),
        },
        {
          runId: "new",
          signalId: "a",
          projectId: "p",
          detectorId: "d",
          seenAt: t(3),
          reportedAt: null,
        },
      ],
    );
    await moveHit(f.db, { projectId: "p", runId: "old", targetId: "b" });
    expect(f.signals.map((s) => [s.hitCount, s.notifiedHitCount])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(f.hits[0]).toMatchObject({ reportedAt: t(2), copyPending: true });
    expect(f.hits[1].reportedAt).toBe(null);
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
  /** An opening: its kept answer (null if none succeeded) and the finding's latest attempt. */
  const rca = (reopenSeq: number, status: string, result: string | null = null) => ({
    reopenSeq,
    findingId: `f${reopenSeq}`,
    createTime: t(reopenSeq),
    result,
    sessionId: result ? `sess-${reopenSeq}` : null,
    rca: { status },
  });

  it("lists a detector's signals with the state of their RCAs", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "a",
        detectorId: "d",
        title: "A",
        status: "open",
        reopenSeq: 1,
        hitCount: 3,
        rcas: [rca(0, "done", "first answer"), rca(1, "running")],
      },
    ]);
    const count = vi.fn(async () => 120);
    const detector = { findMany: vi.fn(async () => [{ id: "d", name: "Failure" }]) };
    const list = await listSignals({ signal: { findMany, count }, detector } as never, {
      projectId: "p",
      detectorIds: ["d"],
      statuses: ["open"],
      page: 2,
      limit: 50,
    });
    expect(list.total).toBe(120);
    expect(list.signals[0]).toMatchObject({
      detectorName: "Failure",
      rca: { currentState: "running", canonicalFindingId: "f0" },
    });
    const where = {
      projectId: "p",
      mergedIntoId: null,
      detectorId: { in: ["d"] },
      status: { in: ["open"] },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 100, take: 50 }));
    expect(count).toHaveBeenCalledWith({ where });
    expect(detector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["d"] } } }),
    );
  });

  it("lists a project's signals by title and id", async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const detector = { findMany: vi.fn() };
    await listSignals({ signal: { findMany, count }, detector } as never, {
      projectId: "p",
      title: "timeout",
      signalId: "a",
      page: 0,
      limit: 50,
    });
    expect(count).toHaveBeenCalledWith({
      where: {
        projectId: "p",
        mergedIntoId: null,
        title: { contains: "timeout", mode: "insensitive" },
        id: "a",
      },
    });
    // No rows, no detector lookup.
    expect(detector.findMany).not.toHaveBeenCalled();
  });

  it("lists the signals of detectors picked by name", async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const detector = { findMany: vi.fn(async () => [{ id: "d1" }, { id: "d2" }]) };
    await listSignals({ signal: { findMany, count }, detector } as never, {
      projectId: "p",
      detectorNames: ["Failure"],
      page: 0,
      limit: 50,
    });
    expect(detector.findMany).toHaveBeenCalledWith({
      where: { projectId: "p", name: { in: ["Failure"] } },
      select: { id: true },
    });
    expect(count).toHaveBeenCalledWith({
      where: { projectId: "p", mergedIntoId: null, detectorId: { in: ["d1", "d2"] } },
    });
  });

  it("counts each listed signal's hits in a window without filtering the list", async () => {
    const findMany = vi.fn(async () => [
      { id: "a", detectorId: "d", reopenSeq: 0, rcas: [] },
      { id: "b", detectorId: "d", reopenSeq: 0, rcas: [] },
    ]);
    const count = vi.fn(async () => 2);
    const detector = { findMany: vi.fn(async () => [{ id: "d", name: "Failure" }]) };
    const groupBy = vi.fn(async () => [{ signalId: "a", _count: { _all: 4 } }]);
    const from = new Date("2026-09-24T00:00:00Z");
    const to = new Date("2026-10-01T00:00:00Z");
    const list = await listSignals(
      { signal: { findMany, count }, signalHit: { groupBy }, detector } as never,
      { projectId: "p", hitsIn: { from, to }, page: 0, limit: 50 },
    );
    expect(count).toHaveBeenCalledWith({ where: { projectId: "p", mergedIntoId: null } });
    expect(groupBy).toHaveBeenCalledWith({
      by: ["signalId"],
      where: { signalId: { in: ["a", "b"] }, traceStartTime: { gte: from, lt: to } },
      _count: { _all: true },
    });
    expect(list.signals.map((s) => [s.id, s.rangeHitCount])).toEqual([
      ["a", 4],
      ["b", 0],
    ]);
  });

  it("returns a signal with its canonical RCA, hits and status history", async () => {
    const db = {
      signal: {
        findFirst: vi.fn(async () => ({
          id: "a",
          detectorId: "d",
          title: "A",
          reopenSeq: 2,
          mergedIntoId: null,
          // Opening 1 kept its answer though the shared finding's latest attempt failed.
          rcas: [rca(2, "failed"), rca(1, "failed", "cause one"), rca(0, "done", "cause zero")],
        })),
      },
      signalHit: {
        findMany: vi.fn(async () => [{ runId: "r1" }]),
        findFirst: vi.fn(async () => ({ traceId: "trace-1" })),
      },
      signalStatusEvent: { findMany: vi.fn(async () => [{ toStatus: "open", reason: "new_hit" }]) },
      detector: { findMany: vi.fn(async () => [{ id: "d", name: "Failure" }]) },
      $queryRaw: vi.fn(async () => [
        { bucket: "2026-09-30", hits: 4 },
        { bucket: "2026-09-28", hits: 1 },
      ]),
    };
    const r = await getSignal(db as never, {
      projectId: "p",
      signalId: "a",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-10-01T00:00:00Z"),
    });
    expect(db.signal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a", projectId: "p" } }),
    );
    expect(r).toMatchObject({
      merged: false,
      signal: {
        rca: { currentState: "failed", canonicalFindingId: "f1" },
        canonicalRca: { findingId: "f1", reopenSeq: 1, result: "cause one", sessionId: "sess-1" },
      },
      hits: [{ runId: "r1" }],
      statusEvents: [{ reason: "new_hit" }],
    });
    expect((r as { signal: { rcaHistory: unknown[] } }).signal.rcaHistory).toHaveLength(3);
    // The analysed trace of the canonical RCA, and the detector's name.
    expect(db.signalHit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { findingId: "f1" } }),
    );
    expect(r).toMatchObject({
      signal: { detectorName: "Failure", canonicalRca: { traceId: "trace-1" } },
    });
    // Only the window's hits are listed.
    expect(db.signalHit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          signalId: "a",
          traceStartTime: {
            gte: new Date("2026-09-01T00:00:00Z"),
            lt: new Date("2026-10-01T00:00:00Z"),
          },
        },
      }),
    );
    // A 30-day window is counted per local day (UTC, with no tz given), with
    // days without hits as zero.
    const { hitSeries, window } = r as unknown as {
      hitSeries: { bucket: string; hits: number }[];
      window: { granularity: string };
    };
    expect(window.granularity).toBe("day");
    expect(hitSeries).toHaveLength(30);
    expect(hitSeries[0]).toEqual({ bucket: "2026-09-01", hits: 0 });
    expect(hitSeries.slice(-3)).toEqual([
      { bucket: "2026-09-28", hits: 1 },
      { bucket: "2026-09-29", hits: 0 },
      { bucket: "2026-09-30", hits: 4 },
    ]);
  });

  const bareSignalDb = (rows: { bucket: string; hits: number }[]) => {
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows);
    return {
      queryRaw,
      db: {
        signal: {
          findFirst: vi.fn(async () => ({
            id: "a",
            detectorId: "d",
            title: "A",
            reopenSeq: 0,
            mergedIntoId: null,
            rcas: [],
          })),
        },
        signalHit: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
        signalStatusEvent: { findMany: vi.fn(async () => []) },
        detector: { findMany: vi.fn(async () => [{ id: "d", name: "Failure" }]) },
        $queryRaw: queryRaw,
      },
    };
  };

  it("buckets a signal's hits by the viewer's local day when tz is given", async () => {
    const { db, queryRaw } = bareSignalDb([{ bucket: "2026-10-01", hits: 2 }]);
    const r = await getSignal(db as never, {
      projectId: "p",
      signalId: "a",
      // Ends 23:30 UTC on the 30th, already Oct 1st in Shanghai (UTC+8).
      from: new Date("2026-09-27T23:30:00Z"),
      to: new Date("2026-09-30T23:30:00Z"),
      tz: "Asia/Shanghai",
    });
    // The labels are the viewer's local dates, a day ahead of the UTC ones.
    const { hitSeries } = r as unknown as { hitSeries: { bucket: string; hits: number }[] };
    expect(hitSeries).toEqual([
      { bucket: "2026-09-28", hits: 0 },
      { bucket: "2026-09-29", hits: 0 },
      { bucket: "2026-09-30", hits: 0 },
      { bucket: "2026-10-01", hits: 2 },
    ]);
    // The zone reaches $queryRaw as a bound parameter, used to convert trace_start_time.
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect(strings.join("")).toContain("AT TIME ZONE");
    expect(values).toContain("Asia/Shanghai");
    expect(values).toContain("day");
  });

  it("counts a window of two days or less per local hour", async () => {
    const { db, queryRaw } = bareSignalDb([{ bucket: "2026-10-01T05:00", hits: 3 }]);
    const r = await getSignal(db as never, {
      projectId: "p",
      signalId: "a",
      // 3 hours in India (UTC+5:30): local hours start on the half hour UTC.
      from: new Date("2026-09-30T23:00:00Z"),
      to: new Date("2026-10-01T02:00:00Z"),
      tz: "Asia/Kolkata",
    });
    const { hitSeries, window } = r as unknown as {
      hitSeries: { bucket: string; hits: number }[];
      window: { granularity: string };
    };
    expect(window.granularity).toBe("hour");
    expect(hitSeries).toEqual([
      { bucket: "2026-10-01T04:00", hits: 0 },
      { bucket: "2026-10-01T05:00", hits: 3 },
      { bucket: "2026-10-01T06:00", hits: 0 },
      { bucket: "2026-10-01T07:00", hits: 0 },
    ]);
    expect(queryRaw.mock.calls[0].slice(1)).toContain("hour");
  });

  it("reads the last 7 days when no window is given, without silently shortening explicit windows", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const { db } = bareSignalDb([]);
    const r = await getSignal(db as never, { projectId: "p", signalId: "a", now });
    expect((r as unknown as { window: { from: Date } }).window.from).toEqual(
      new Date("2026-09-24T12:00:00Z"),
    );
    const long = await getSignal(db as never, {
      projectId: "p",
      signalId: "a",
      from: new Date("2025-01-01T00:00:00Z"),
      to: now,
    });
    expect((long as unknown as { window: { from: Date } }).window.from).toEqual(
      new Date("2025-01-01T00:00:00Z"),
    );
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

  it("reads the signals settings of the named detectors, in the project only", async () => {
    const db = { detector: { findMany: vi.fn(async () => [{ id: "d" }]) } };
    expect(
      await detectorSignalSettings(db as never, { projectId: "p", detectorIds: ["d", "e"] }),
    ).toEqual([{ id: "d" }]);
    expect(db.detector.findMany).toHaveBeenCalledWith({
      where: { projectId: "p", id: { in: ["d", "e"] } },
      select: { id: true, enableSignals: true, signalsEnabledAt: true },
    });
    expect(await detectorSignalSettings(db as never, { projectId: "p", detectorIds: [] })).toEqual(
      [],
    );
    expect(db.detector.findMany).toHaveBeenCalledTimes(1);
  });

  it("counts the project's signals and how far its detectors are set up", async () => {
    const counts = [2, 1, 0];
    const db = {
      signal: { count: vi.fn(async () => 0) },
      detector: { count: vi.fn(async (_args: unknown) => counts.shift()) },
    };
    expect(await signalSetup(db as never, "p")).toEqual({
      signalCount: 0,
      detectorCount: 2,
      signalDetectorCount: 1,
      sampledSignalDetectorCount: 0,
    });
    // A merged signal is listed under its target, so it is not counted.
    expect(db.signal.count).toHaveBeenCalledWith({ where: { projectId: "p", mergedIntoId: null } });
    expect(db.detector.count.mock.calls.map((c) => c[0])).toEqual([
      { where: { projectId: "p" } },
      { where: { projectId: "p", enableSignals: true } },
      { where: { projectId: "p", enableSignals: true, enabled: true, sampleRate: { gt: 0 } } },
    ]);
  });
});
