import { describe, expect, it } from "vitest";
import { applyAssignment, type Placement, type WaitingHit } from "../write.js";

type SignalRow = {
  id: string;
  projectId: string;
  detectorId: string;
  status: string;
  resolvedAt: Date | null;
  reopenSeq: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  mergedIntoId: string | null;
  groupKey: string | null;
  hitCount: number;
  criteriaVersion: number;
};

const ASSIGNED_AT = new Date("2026-09-30T10:00:05Z");

/** In-memory stand-in for the tables the write touches, logging statement order. */
function fakeDb(
  signals: SignalRow[],
  hits: {
    runId: string;
    signalId: string;
    score?: number | null;
    criteriaVersion?: number | null;
  }[] = [],
) {
  const log: string[] = [];
  const events: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const hitRows: Record<string, unknown>[] = [];
  const pick = (row: SignalRow | undefined) => row ?? null;
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      log.push(`lock:${v.join("/")}`);
      return 1;
    },
    signalHit: {
      findUnique: async ({ where }: { where: { runId: string } }) => {
        log.push("hit?");
        const h = hits.find((x) => x.runId === where.runId);
        if (!h) return null;
        const s = signals.find((x) => x.id === h.signalId)!;
        return {
          score: h.score ?? null,
          criteriaVersion: h.criteriaVersion ?? null,
          assignedAt: ASSIGNED_AT,
          signal: { id: s.id, reopenSeq: s.reopenSeq },
        };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        log.push("hit+");
        hitRows.push(data);
        return { assignedAt: ASSIGNED_AT };
      },
    },
    signal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        pick(signals.find((s) => s.id === where.id)),
      findFirst: async ({
        where,
      }: {
        where: { projectId: string; groupKey: string; detectorId: string };
      }) =>
        pick(
          signals.find(
            (s) =>
              s.projectId === where.projectId &&
              s.groupKey === where.groupKey &&
              s.detectorId === where.detectorId,
          ),
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        log.push(`update:${where.id}`);
        const s = signals.find((x) => x.id === where.id)!;
        if ("reopenSeq" in data) {
          s.status = "open";
          s.resolvedAt = null;
          s.reopenSeq += 1;
          return { reopenSeq: s.reopenSeq };
        }
        s.hitCount += 1;
        s.firstSeenAt = data.firstSeenAt as Date;
        s.lastSeenAt = data.lastSeenAt as Date;
        return s;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        log.push("create");
        created.push(data);
        return { id: "new-sig", criteriaVersion: 1 };
      },
    },
    signalStatusEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        log.push("event");
        events.push(data);
      },
    },
  };
  const db = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { db: db as never, log, events, created, hitRows };
}

const t = (iso: string) => new Date(`2026-09-30T${iso}Z`);
const signal = (over: Partial<SignalRow>): SignalRow => ({
  id: "sigA",
  projectId: "p",
  detectorId: "d",
  status: "open",
  resolvedAt: null,
  reopenSeq: 0,
  firstSeenAt: t("09:00:00"),
  lastSeenAt: t("09:00:00"),
  mergedIntoId: null,
  groupKey: null,
  hitCount: 4,
  criteriaVersion: 2,
  ...over,
});
const hit = (over: Partial<WaitingHit> = {}): WaitingHit => ({
  runId: "run1",
  projectId: "p",
  detectorId: "d",
  traceId: "trace1",
  findingId: "f1",
  seenAt: t("10:00:00"),
  traceStartTime: t("09:59:00"),
  summary: "s",
  data: {},
  groupKey: null,
  ...over,
});
const attach = (signalId = "sigA", score: number | null = 0.95): Placement => ({
  kind: "attach",
  signalId,
  score,
  criteriaVersion: 2,
});

describe("applyAssignment", () => {
  it("attaches under the partition lock and records the hit with its score and criteria version", async () => {
    const f = fakeDb([signal({})]);
    const r = await applyAssignment(f.db, hit(), attach());
    expect(r).toEqual({
      outcome: "attached",
      signalId: "sigA",
      reopenSeq: 0,
      score: 0.95,
      criteriaVersion: 2,
      assignedAt: ASSIGNED_AT,
    });
    expect(f.log).toEqual(["lock:p/d", "hit?", "update:sigA", "hit+"]);
    expect(f.hitRows[0]).toMatchObject({
      runId: "run1",
      signalId: "sigA",
      score: 0.95,
      criteriaVersion: 2,
      findingId: "f1",
      traceId: "trace1",
    });
  });

  it("widens first and last seen", async () => {
    const rows = [signal({})];
    const f = fakeDb(rows);
    await applyAssignment(f.db, hit({ seenAt: t("08:00:00") }), attach());
    expect(rows[0].firstSeenAt).toEqual(t("08:00:00"));
    expect(rows[0].lastSeenAt).toEqual(t("09:00:00"));
    expect(rows[0].hitCount).toBe(5);
  });

  it("returns the stored assignment unchanged when the hit is already recorded", async () => {
    const f = fakeDb(
      [signal({ reopenSeq: 2 })],
      [{ runId: "run1", signalId: "sigA", score: 0.7, criteriaVersion: 1 }],
    );
    const r = await applyAssignment(f.db, hit(), attach("", null));
    expect(r).toEqual({
      outcome: "duplicate",
      signalId: "sigA",
      reopenSeq: 2,
      score: 0.7,
      criteriaVersion: 1,
      assignedAt: ASSIGNED_AT,
    });
    expect(f.log).toEqual(["lock:p/d", "hit?"]);
  });

  it("follows a merge made after the decision and drops the criteria version", async () => {
    const f = fakeDb([signal({ id: "sigA", mergedIntoId: "sigB" }), signal({ id: "sigB" })]);
    const r = await applyAssignment(f.db, hit(), attach("sigA"));
    expect(r.signalId).toBe("sigB");
    expect(r.criteriaVersion).toBe(null);
    // The score was judged against the merged-away signal, so it is not kept.
    expect(r.score).toBe(null);
    expect(f.hitRows[0]).toMatchObject({ signalId: "sigB", criteriaVersion: null, score: null });
  });

  it("refuses a merge cycle and a vanished target", async () => {
    const cycle = fakeDb([
      signal({ id: "sigA", mergedIntoId: "sigB" }),
      signal({ id: "sigB", mergedIntoId: "sigA" }),
    ]);
    await expect(applyAssignment(cycle.db, hit(), attach("sigA"))).rejects.toThrow("merge chain");
    const gone = fakeDb([]);
    await expect(applyAssignment(gone.db, hit(), attach("sigA"))).rejects.toThrow("vanished");
  });

  it("reopens a resolved signal for a trace that started after the resolve", async () => {
    const rows = [signal({ status: "resolved", resolvedAt: t("09:30:00"), reopenSeq: 1 })];
    const f = fakeDb(rows);
    const r = await applyAssignment(f.db, hit({ traceStartTime: t("09:45:00") }), attach());
    expect(r).toMatchObject({ outcome: "reopened", signalId: "sigA", reopenSeq: 2 });
    expect(f.events[0]).toMatchObject({
      actorUserId: "system",
      fromStatus: "resolved",
      toStatus: "open",
      reason: "new_hit",
    });
    expect(rows[0].status).toBe("open");
  });

  it("counts a late hit from a trace that started before the resolve without reopening", async () => {
    const rows = [signal({ status: "resolved", resolvedAt: t("09:30:00") })];
    const f = fakeDb(rows);
    const r = await applyAssignment(f.db, hit({ traceStartTime: t("09:20:00") }), attach());
    expect(r.outcome).toBe("attached");
    expect(f.events).toEqual([]);
    expect(rows[0].status).toBe("resolved");
  });

  it("counts hits on a dismissed signal silently", async () => {
    const rows = [signal({ status: "dismissed" })];
    const f = fakeDb(rows);
    const r = await applyAssignment(f.db, hit({ traceStartTime: t("11:00:00") }), attach());
    expect(r.outcome).toBe("attached");
    expect(rows[0].status).toBe("dismissed");
    expect(rows[0].hitCount).toBe(5);
  });

  it("creates a signal with this hit as its anchor, keeping its criteria check result", async () => {
    const f = fakeDb([]);
    const r = await applyAssignment(f.db, hit(), {
      kind: "create",
      signal: { title: "T", covers: "C", excludes: "E" },
      anchorText: "material",
      anchorEmbedding: [0.1, 0.2],
      validated: false,
    });
    expect(r).toMatchObject({
      outcome: "created",
      signalId: "new-sig",
      reopenSeq: 0,
      criteriaVersion: 1,
      score: null,
    });
    expect(f.created[0]).toMatchObject({
      title: "T",
      criteriaCovers: "C",
      criteriaExcludes: "E",
      anchorText: "material",
      anchorEmbedding: [0.1, 0.2],
      groupKey: null,
      criteriaValidated: false,
      hitCount: 1,
      firstSeenAt: t("10:00:00"),
    });
    expect(f.hitRows[0]).toMatchObject({ signalId: "new-sig", criteriaVersion: 1, score: null });
  });

  it("groups a Jev-path hit into its category's signal, creating it once", async () => {
    const group: Placement = {
      kind: "group",
      groupKey: "fabrication",
      signal: { title: "Fabrication", covers: "c", excludes: "" },
      anchorText: "m",
    };
    const fresh = fakeDb([]);
    expect((await applyAssignment(fresh.db, hit(), group)).outcome).toBe("created");
    // A category signal's criteria are fixed text: no check ran.
    expect(fresh.created[0]).toMatchObject({
      groupKey: "fabrication",
      anchorEmbedding: [],
      criteriaValidated: null,
    });
    // Category signals are never judged against criteria, so no version is recorded.
    expect(fresh.hitRows[0]).toMatchObject({ criteriaVersion: null });

    const existing = fakeDb([
      signal({ id: "other-project", projectId: "q", groupKey: "fabrication" }),
      signal({ id: "sigG", groupKey: "fabrication" }),
    ]);
    const r = await applyAssignment(existing.db, hit(), group);
    expect(r).toMatchObject({ outcome: "attached", signalId: "sigG" });
  });
});
