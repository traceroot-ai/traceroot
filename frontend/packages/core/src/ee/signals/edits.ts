import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockSignalPartition } from "./partition-lock.ts";

type Tx = Prisma.TransactionClient;

/** Hits whose ClickHouse copy must be rewritten to a new signal after the commit. */
export interface MovedHits {
  projectId: string;
  detectorId: string;
  signalId: string;
  /** When the user placed them; the copy keeps its latest row by this time. */
  assignedAt: Date;
  runIds: string[];
}

export type EditResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 404 | 409; error: string };

const NOT_FOUND = { ok: false, status: 404, error: "Signal not found" } as const;

/** A hand edit of a signal's title and membership criteria. */
export const signalCriteriaEditSchema = z.object({
  title: z.string().trim().min(1).max(200),
  covers: z.string().trim().min(1).max(4000),
  excludes: z.string().trim().max(4000),
  /** The version the user edited; a newer one means someone else edited first. */
  expectedCriteriaVersion: z.number().int().min(1),
});
export type SignalCriteriaEdit = z.output<typeof signalCriteriaEditSchema>;

/**
 * The time a user places hits: later than each hit's previous assignment. The
 * ClickHouse copy keeps the row with the latest time per hit, so the newest
 * placement wins however the copy rewrites of two edits are ordered.
 */
function placedAt(previous: Date | null | undefined): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
}

/** Recompute a signal's hit count and first/last seen from its hits. */
async function recount(tx: Tx, signalId: string): Promise<void> {
  const agg = await tx.signalHit.aggregate({
    where: { signalId },
    _count: { _all: true, reportedAt: true },
    _min: { seenAt: true },
    _max: { seenAt: true },
  });
  const count = agg._count._all;
  await tx.signal.update({
    where: { id: signalId },
    data: {
      hitCount: count,
      notifiedHitCount: agg._count.reportedAt,
      ...(count > 0 ? { firstSeenAt: agg._min.seenAt!, lastSeenAt: agg._max.seenAt! } : {}),
    },
  });
}

/**
 * Replace a signal's title and criteria under the partition lock. Bumps the
 * criteria version, so hits judged before the edit stay attributable to the
 * version they were judged under.
 */
export async function editSignalCriteria(
  db: Pick<PrismaClient, "$transaction">,
  params: { projectId: string; signalId: string; edit: SignalCriteriaEdit },
): Promise<EditResult<{ criteriaVersion: number }>> {
  return db.$transaction(async (tx) => {
    const found = await tx.signal.findFirst({
      where: { id: params.signalId, projectId: params.projectId },
      select: { detectorId: true },
    });
    if (!found) return NOT_FOUND;
    await lockSignalPartition(tx, params.projectId, found.detectorId);
    const current = await tx.signal.findUniqueOrThrow({
      where: { id: params.signalId },
      select: { criteriaVersion: true, mergedIntoId: true, groupKey: true },
    });
    if (current.mergedIntoId) return { ok: false, status: 409, error: "Signal was merged" };
    if (current.groupKey) {
      return { ok: false, status: 400, error: "Category signals have fixed criteria" };
    }
    if (current.criteriaVersion !== params.edit.expectedCriteriaVersion) {
      return { ok: false, status: 409, error: "The criteria were edited since you opened them" };
    }
    const updated = await tx.signal.update({
      where: { id: params.signalId },
      data: {
        title: params.edit.title,
        criteriaCovers: params.edit.covers,
        criteriaExcludes: params.edit.excludes,
        criteriaVersion: { increment: 1 },
      },
      select: { criteriaVersion: true },
    });
    return { ok: true, criteriaVersion: updated.criteriaVersion };
  });
}

/**
 * Merge one signal into another of the same detector: its hits move to the
 * target, and it keeps a pointer so an in-flight assignment follows it. Moved
 * hits were judged against the source's criteria, so they record no version.
 * The target's reported hit count grows by what was already reported for the
 * source, so the digest does not report those hits as new.
 *
 * The source's RCAs move with it, numbered below zero on the target (newest
 * first: -1, -2, ...) so they never pose as one of the target's own openings.
 * The canonical RCA (highest reopen_seq that is done) therefore prefers the
 * target's own RCA and falls back to the merged-in one.
 */
export async function mergeSignals(
  db: Pick<PrismaClient, "$transaction">,
  params: { projectId: string; sourceId: string; targetId: string },
): Promise<EditResult<{ moved: MovedHits }>> {
  if (params.sourceId === params.targetId) {
    return { ok: false, status: 400, error: "A signal cannot be merged into itself" };
  }
  return db.$transaction(async (tx) => {
    const select = {
      id: true,
      detectorId: true,
      mergedIntoId: true,
      notifiedHitCount: true,
      groupKey: true,
    } as const;
    const [source, target] = await Promise.all([
      tx.signal.findFirst({ where: { id: params.sourceId, projectId: params.projectId }, select }),
      tx.signal.findFirst({ where: { id: params.targetId, projectId: params.projectId }, select }),
    ]);
    if (!source || !target) return NOT_FOUND;
    if (source.detectorId !== target.detectorId) {
      return { ok: false, status: 400, error: "Only signals of the same detector can be merged" };
    }
    await lockSignalPartition(tx, params.projectId, source.detectorId);
    const [s, t] = await Promise.all([
      tx.signal.findUniqueOrThrow({ where: { id: source.id }, select }),
      tx.signal.findUniqueOrThrow({ where: { id: target.id }, select }),
    ]);
    if (s.mergedIntoId || t.mergedIntoId) {
      return { ok: false, status: 409, error: "One of the signals was already merged" };
    }
    const hits = await tx.signalHit.findMany({
      where: { signalId: s.id },
      select: { runId: true, assignedAt: true },
    });
    const assignedAt = placedAt(
      hits.reduce<Date | null>((m, h) => (!m || h.assignedAt > m ? h.assignedAt : m), null),
    );
    await tx.signalHit.updateMany({
      where: { signalId: s.id },
      data: { signalId: t.id, criteriaVersion: null, score: null, assignedAt, copyPending: true },
    });
    await tx.signal.update({
      where: { id: s.id },
      data: { mergedIntoId: t.id, hitCount: 0, notifiedHitCount: 0 },
    });
    await recount(tx, t.id);

    const carried = await tx.signalRca.findMany({
      where: { signalId: s.id },
      orderBy: { createTime: "desc" },
      select: { findingId: true, createTime: true },
    });
    if (carried.length > 0) {
      const lowest = await tx.signalRca.aggregate({
        where: { signalId: t.id },
        _min: { reopenSeq: true },
      });
      let seq = Math.min(0, lowest._min.reopenSeq ?? 0) - 1;
      await tx.signalRca.deleteMany({ where: { signalId: s.id } });
      for (const r of carried) {
        await tx.signalRca.create({
          data: {
            signalId: t.id,
            reopenSeq: seq--,
            findingId: r.findingId,
            createTime: r.createTime,
          },
        });
      }
    }
    return {
      ok: true,
      moved: {
        projectId: params.projectId,
        detectorId: s.detectorId,
        signalId: t.id,
        assignedAt,
        runIds: hits.map((h) => h.runId),
      },
    };
  });
}

/**
 * Move one hit to another signal of the same detector. The hit records no
 * criteria version or score: a user placed it. When the source had already
 * reported the hit, the report moves with it, so the source does not hide its
 * next new hit and the target does not report this one again.
 */
export async function moveHit(
  db: Pick<PrismaClient, "$transaction">,
  params: { projectId: string; runId: string; targetId: string },
): Promise<EditResult<{ moved: MovedHits }>> {
  return db.$transaction(async (tx) => {
    const hit = await tx.signalHit.findFirst({
      where: { runId: params.runId, projectId: params.projectId },
      select: { signalId: true, detectorId: true },
    });
    if (!hit) return { ok: false, status: 404, error: "Hit not found" };
    await lockSignalPartition(tx, params.projectId, hit.detectorId);
    const target = await tx.signal.findFirst({
      where: { id: params.targetId, projectId: params.projectId },
      select: { detectorId: true, mergedIntoId: true },
    });
    if (!target) return NOT_FOUND;
    if (target.detectorId !== hit.detectorId) {
      return { ok: false, status: 400, error: "A hit can only move to a signal of its detector" };
    }
    if (target.mergedIntoId) return { ok: false, status: 409, error: "Signal was merged" };
    // Re-read under the lock: the hit may have moved since.
    const current = await tx.signalHit.findUniqueOrThrow({
      where: { runId: params.runId },
      select: { signalId: true, assignedAt: true },
    });
    const moved = {
      projectId: params.projectId,
      detectorId: hit.detectorId,
      signalId: params.targetId,
      assignedAt: current.assignedAt,
      runIds: [] as string[],
    };
    if (current.signalId === params.targetId) return { ok: true, moved };
    const assignedAt = placedAt(current.assignedAt);
    await tx.signalHit.update({
      where: { runId: params.runId },
      data: {
        signalId: params.targetId,
        criteriaVersion: null,
        score: null,
        assignedAt,
        copyPending: true,
      },
    });
    await recount(tx, current.signalId);
    await recount(tx, params.targetId);
    return { ok: true, moved: { ...moved, assignedAt, runIds: [params.runId] } };
  });
}
