import type { PrismaClient } from "@prisma/client";
import { pickCanonicalRca } from "./canonical-rca.ts";

type ReadDb = Pick<
  PrismaClient,
  "signal" | "signalHit" | "signalStatusEvent" | "detector" | "$queryRaw"
>;

/** Most recent hits and status changes returned with a signal. */
const DETAIL_LIMIT = 50;
const DAY_MS = 86_400_000;
/** The window a signal's hits are counted in when the caller names none: the last 7 days. */
const DEFAULT_RANGE_MS = 7 * DAY_MS;
/** At or below this window the hit series is per hour, as on the dashboards; above, per day. */
const HOUR_BUCKET_MAX_MS = 2 * DAY_MS;

type OpeningRow = {
  reopenSeq: number;
  findingId: string;
  createTime: Date;
  rca: {
    status: string;
    result?: string | null;
    completedAt?: Date | null;
    sessionId?: string | null;
  };
};

/** The RCA state of the signal's current opening, and whether any RCA finished. */
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
 * One page of a project's signals, newest first, and how many there are.
 * Merged signals are left out.
 */
export async function listSignals(
  db: Pick<PrismaClient, "signal" | "signalHit" | "detector">,
  params: {
    projectId: string;
    detectorIds?: string[];
    /** Detectors picked by name; a name need not be unique, so every match counts. */
    detectorNames?: string[];
    statuses?: string[];
    /** Case-insensitive substring of the title. */
    title?: string;
    signalId?: string;
    /**
     * A time window that does not filter the list: each signal also gets
     * `rangeHitCount`, the number of affected traces starting in [from, to).
     */
    hitsIn?: { from: Date; to: Date };
    page: number;
    limit: number;
  },
) {
  let detectorIds = params.detectorIds;
  if (params.detectorNames) {
    const named = await db.detector.findMany({
      where: { projectId: params.projectId, name: { in: params.detectorNames } },
      select: { id: true },
    });
    const ids = named.map((d) => d.id);
    detectorIds = detectorIds ? detectorIds.filter((id) => ids.includes(id)) : ids;
  }
  const where = {
    projectId: params.projectId,
    mergedIntoId: null,
    ...(detectorIds ? { detectorId: { in: detectorIds } } : {}),
    ...(params.statuses ? { status: { in: params.statuses } } : {}),
    ...(params.title ? { title: { contains: params.title, mode: "insensitive" as const } } : {}),
    ...(params.signalId ? { id: params.signalId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.signal.findMany({
      where,
      orderBy: [{ createTime: "desc" }, { id: "asc" }],
      skip: params.page * params.limit,
      take: params.limit,
      select: {
        id: true,
        detectorId: true,
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
            rca: { select: { status: true } },
          },
        },
      },
    }),
    db.signal.count({ where }),
  ]);
  const [names, inRange] = await Promise.all([
    detectorNames(
      db,
      rows.map((r) => r.detectorId),
    ),
    params.hitsIn && rows.length > 0
      ? db.signalHit.groupBy({
          by: ["signalId"],
          where: {
            signalId: { in: rows.map((r) => r.id) },
            traceStartTime: { gte: params.hitsIn.from, lt: params.hitsIn.to },
          },
          _count: { _all: true },
        })
      : null,
  ]);
  const rangeCounts = new Map(inRange?.map((g) => [g.signalId, g._count._all]));
  return {
    signals: rows.map(({ rcas, ...s }) => ({
      ...s,
      detectorName: names.get(s.detectorId) ?? null,
      rca: rcaSummary(rcas, s.reopenSeq),
      ...(params.hitsIn ? { rangeHitCount: rangeCounts.get(s.id) ?? 0 } : {}),
    })),
    total,
  };
}

/** Detector id -> name; signals have no relation to detectors in the schema. */
async function detectorNames(db: Pick<PrismaClient, "detector">, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const detectors = await db.detector.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(detectors.map((d) => [d.id, d.name]));
}

export type HitGranularity = "hour" | "day";

/**
 * Formats a moment as its local bucket in `tz`: "YYYY-MM-DD" for a day,
 * "YYYY-MM-DDTHH:00" for an hour.
 */
function bucketFormatter(tz: string, granularity: HitGranularity) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return (date: Date) => {
    const part = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
    const day = `${part.year}-${part.month}-${part.day}`;
    return granularity === "day" ? day : `${day}T${part.hour}:00`;
  };
}

/** Every local bucket the window [from, to) touches, oldest first. */
function windowBuckets(from: Date, to: Date, tz: string, granularity: HitGranularity): string[] {
  if (from.getTime() >= to.getTime()) return [];
  const bucketOf = bucketFormatter(tz, granularity);
  // A step shorter than any bucket lands in each of them, whatever the zone's
  // offset: local hours can start on a quarter hour, local days last 23h or more.
  const step = granularity === "hour" ? 15 * 60_000 : 3_600_000;
  const buckets: string[] = [];
  const add = (t: number) => {
    const b = bucketOf(new Date(t));
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  };
  for (let t = from.getTime(); t < to.getTime(); t += step) add(t);
  add(to.getTime() - 1);
  return buckets;
}

/**
 * The signal's hits per local bucket of [from, to), oldest first; a bucket
 * without hits is 0.
 */
async function hitSeries(
  db: Pick<PrismaClient, "$queryRaw">,
  signalId: string,
  window: { from: Date; to: Date },
  tz: string,
  granularity: HitGranularity,
) {
  const format = granularity === "hour" ? 'YYYY-MM-DD"T"HH24:00' : "YYYY-MM-DD";
  // trace_start_time is UTC without a zone: read it as UTC, then shift it to the viewer's zone.
  const rows = await db.$queryRaw<{ bucket: string; hits: number }[]>`
    SELECT to_char(date_trunc(${granularity}, (trace_start_time AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), ${format}) AS bucket,
      count(*)::int AS hits
    FROM signal_hits
    WHERE signal_id = ${signalId}
      AND trace_start_time >= (${window.from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND trace_start_time < (${window.to.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1`;
  const byBucket = new Map(rows.map((r) => [r.bucket, Number(r.hits)]));
  return windowBuckets(window.from, window.to, tz, granularity).map((bucket) => ({
    bucket,
    hits: byBucket.get(bucket) ?? 0,
  }));
}

/**
 * The window a signal is read in: [from, to) as asked, or the last 7 days,
 * and whether its hits are counted per hour or per day. Retention is enforced by the caller.
 */
function readWindow(from?: Date, to?: Date, now = new Date()) {
  const end = to ?? now;
  let start = from ?? new Date(end.getTime() - DEFAULT_RANGE_MS);
  if (start.getTime() > end.getTime()) start = end;
  const granularity: HitGranularity =
    end.getTime() - start.getTime() <= HOUR_BUCKET_MAX_MS ? "hour" : "day";
  return { from: start, to: end, granularity };
}

/**
 * One signal with its criteria, canonical RCA, recent hits and status history.
 * A merged signal returns only where it went, so a caller can follow it.
 */
export async function getSignal(
  db: ReadDb,
  params: {
    projectId: string;
    signalId: string;
    /** The window hits are read in, [from, to); the last 7 days by default. */
    from?: Date;
    to?: Date;
    now?: Date;
    /** An IANA zone name the caller has already validated; local buckets follow it. */
    tz?: string;
  },
) {
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
          rca: { select: { status: true, result: true, completedAt: true, sessionId: true } },
        },
        orderBy: { reopenSeq: "desc" },
      },
    },
  });
  if (!signal) return null;
  if (signal.mergedIntoId) return { merged: true as const, mergedIntoId: signal.mergedIntoId };

  const { rcas, ...rest } = signal;
  const canonical = pickCanonicalRca(rcas);
  const window = readWindow(params.from, params.to, params.now);
  const tz = params.tz ?? "UTC";
  const [hits, events, names, series, analysed] = await Promise.all([
    db.signalHit.findMany({
      where: { signalId: signal.id, traceStartTime: { gte: window.from, lt: window.to } },
      orderBy: [{ traceStartTime: "desc" }, { runId: "asc" }],
      take: DETAIL_LIMIT,
      select: {
        runId: true,
        traceId: true,
        findingId: true,
        seenAt: true,
        traceStartTime: true,
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
    detectorNames(db, [signal.detectorId]),
    hitSeries(db, signal.id, window, tz, window.granularity),
    // The trace the canonical RCA analysed, to link it from the signal.
    canonical
      ? db.signalHit.findFirst({
          where: { findingId: canonical.findingId },
          select: { traceId: true },
        })
      : null,
  ]);
  return {
    merged: false as const,
    signal: {
      ...rest,
      detectorName: names.get(rest.detectorId) ?? null,
      rca: rcaSummary(rcas, rest.reopenSeq),
      canonicalRca: canonical
        ? {
            findingId: canonical.findingId,
            traceId: analysed?.traceId ?? null,
            // The agent session of the RCA, to reopen it in the assistant.
            sessionId: canonical.rca.sessionId ?? null,
            reopenSeq: canonical.reopenSeq,
            result: canonical.rca.result ?? null,
            completedAt: canonical.rca.completedAt ?? null,
          }
        : null,
      rcaHistory: rcas.map((r) => ({
        reopenSeq: r.reopenSeq,
        findingId: r.findingId,
        status: r.rca.status,
        createTime: r.createTime,
      })),
    },
    /** The latest affected traces starting in the window. */
    hits,
    window: { from: window.from, to: window.to, granularity: window.granularity },
    /** Hits per local bucket of the window, oldest first. */
    hitSeries: series,
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
