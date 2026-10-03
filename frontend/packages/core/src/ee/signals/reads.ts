import type { PrismaClient } from "@prisma/client";
import { pickCanonicalRca } from "./canonical-rca.ts";

type ReadDb = Pick<PrismaClient, "signal" | "signalHit" | "signalStatusEvent">;

/** Most recent hits and status changes returned with a signal. */
const DETAIL_LIMIT = 50;

type OpeningRow = {
  reopenSeq: number;
  findingId: string;
  createTime: Date;
  /** The last successful answer that covered this opening, kept on it. */
  result: string | null;
  /** The finding's latest attempt. */
  rca: { status: string };
};

/** The RCA state of the signal's current opening, and whether any RCA succeeded. */
function rcaSummary(rcas: OpeningRow[], reopenSeq: number) {
  const current = rcas.find((r) => r.reopenSeq === reopenSeq);
  const canonical = pickCanonicalRca(rcas);
  return {
    /** RCA of the current opening: null when none ran (RCA off, or within the cooldown). */
    currentState: current ? current.rca.status : null,
    canonicalFindingId: canonical?.findingId ?? null,
  };
}

/**
 * One page of a detector's signals, most recently seen first, and how many
 * there are. Merged signals are left out.
 */
export async function listSignals(
  db: Pick<PrismaClient, "signal">,
  params: { projectId: string; detectorId: string; status?: string; page: number; limit: number },
) {
  const where = {
    projectId: params.projectId,
    detectorId: params.detectorId,
    mergedIntoId: null,
    ...(params.status ? { status: params.status } : {}),
  };
  const [rows, total] = await Promise.all([
    db.signal.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      skip: params.page * params.limit,
      take: params.limit,
      select: {
        id: true,
        title: true,
        status: true,
        hitCount: true,
        firstSeenAt: true,
        lastSeenAt: true,
        reopenSeq: true,
        criteriaVersion: true,
        groupKey: true,
        createTime: true,
        rcas: {
          select: {
            reopenSeq: true,
            findingId: true,
            createTime: true,
            result: true,
            rca: { select: { status: true } },
          },
        },
      },
    }),
    db.signal.count({ where }),
  ]);
  return {
    signals: rows.map(({ rcas, ...s }) => ({ ...s, rca: rcaSummary(rcas, s.reopenSeq) })),
    total,
  };
}

/**
 * One signal with its criteria, canonical RCA, recent hits and status history.
 * A merged signal returns only where it went, so a caller can follow it.
 */
export async function getSignal(db: ReadDb, params: { projectId: string; signalId: string }) {
  const signal = await db.signal.findFirst({
    where: { id: params.signalId, projectId: params.projectId },
    select: {
      id: true,
      detectorId: true,
      title: true,
      criteriaCovers: true,
      criteriaExcludes: true,
      criteriaVersion: true,
      groupKey: true,
      status: true,
      resolvedAt: true,
      reopenSeq: true,
      hitCount: true,
      firstSeenAt: true,
      lastSeenAt: true,
      mergedIntoId: true,
      createTime: true,
      rcas: {
        select: {
          reopenSeq: true,
          findingId: true,
          createTime: true,
          result: true,
          sessionId: true,
          rca: { select: { status: true } },
        },
        orderBy: { reopenSeq: "desc" },
      },
    },
  });
  if (!signal) return null;
  if (signal.mergedIntoId) return { merged: true as const, mergedIntoId: signal.mergedIntoId };

  const [hits, events] = await Promise.all([
    db.signalHit.findMany({
      where: { signalId: signal.id },
      orderBy: { seenAt: "desc" },
      take: DETAIL_LIMIT,
      select: {
        runId: true,
        traceId: true,
        findingId: true,
        seenAt: true,
        score: true,
        criteriaVersion: true,
        assignedAt: true,
      },
    }),
    db.signalStatusEvent.findMany({
      where: { signalId: signal.id },
      orderBy: { createTime: "desc" },
      take: DETAIL_LIMIT,
      select: {
        actorUserId: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        note: true,
        createTime: true,
      },
    }),
  ]);
  const { rcas, ...rest } = signal;
  const canonical = pickCanonicalRca(rcas);
  return {
    merged: false as const,
    signal: {
      ...rest,
      rca: rcaSummary(rcas, rest.reopenSeq),
      // The newest opening that kept a successful answer: a later failed or
      // pending attempt on a shared finding does not take it away.
      canonicalRca: canonical
        ? {
            findingId: canonical.findingId,
            reopenSeq: canonical.reopenSeq,
            result: canonical.result,
            sessionId: canonical.sessionId,
          }
        : null,
      rcaHistory: rcas.map((r) => ({
        reopenSeq: r.reopenSeq,
        findingId: r.findingId,
        status: r.rca.status,
        createTime: r.createTime,
      })),
    },
    hits,
    statusEvents: events,
  };
}

/** The signal each hit of a trace belongs to, for the trace page and the finding panel. */
export async function signalsForTrace(
  db: Pick<PrismaClient, "signalHit">,
  params: { projectId: string; traceId: string },
) {
  const hits = await db.signalHit.findMany({
    where: { projectId: params.projectId, traceId: params.traceId },
    select: {
      runId: true,
      detectorId: true,
      findingId: true,
      signal: { select: { id: true, title: true, status: true } },
    },
  });
  return hits.map((h) => ({
    runId: h.runId,
    detectorId: h.detectorId,
    findingId: h.findingId,
    signalId: h.signal.id,
    signalTitle: h.signal.title,
    signalStatus: h.signal.status,
  }));
}
