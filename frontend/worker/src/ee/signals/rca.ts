import { Queue } from "bullmq";
import type { PrismaClient } from "@traceroot/core";
import { removeOrphanSignalRcas } from "@traceroot/core/rca-executions";
import {
  DETECTOR_RCA_QUEUE,
  createRedisConnection,
  type DetectorRcaFinding,
  type RcaJob,
} from "../../queues/detector-run-queue.js";
import type { SignalsBackend } from "./backend-client.js";
import { RCA_DELAY_MS, RCA_STALE_MS, WAITING_LOOKBACK_MS } from "./config.js";

let rcaQueue: Queue<RcaJob> | null = null;
function getRcaQueue(): Queue<RcaJob> {
  rcaQueue ??= new Queue<RcaJob>(DETECTOR_RCA_QUEUE, { connection: createRedisConnection() });
  return rcaQueue;
}

/**
 * Enqueue the RCA of a finding whose hit started or reopened a signal. One job
 * per finding; the job reads the signals to analyse when it runs, so another
 * hit of the same trace opening a signal before then is included. Finished and
 * failed jobs are removed at once: a kept job would swallow the add of a later
 * opening under the same id. The id prefix differs from per-finding RCA jobs
 * from before signals, so one of those still kept cannot swallow it either.
 */
export async function enqueueSignalRca(
  findingId: string,
  projectId: string,
  delayMs: number = RCA_DELAY_MS,
): Promise<void> {
  await getRcaQueue().add(
    signalRcaJobId(findingId),
    { kind: "signals", findingId, projectId },
    {
      jobId: signalRcaJobId(findingId),
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: true,
      // Each attempt re-runs the agent; a few attempts ride out rate limits
      // and provider 5xx without failing the RCA on one shot.
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    },
  );
}

export const signalRcaJobId = (findingId: string) => `signal-rca-${findingId}`;

type RcaDb = Pick<PrismaClient, "signalRca" | "signalHit" | "project" | "detector">;

export interface SignalRcaContext {
  traceId: string;
  workspaceId: string;
  /** Detection time of the earliest hit analysed; keys the per-finding digest window. */
  findingTimestamp: number;
  /** One entry per hit to analyse, with its signal's title. */
  findings: DetectorRcaFinding[];
  /** The signal openings this run covers, as "signalId:reopenSeq". */
  covered: string[];
}

const openingKey = (r: { signalId: string; reopenSeq: number }) => `${r.signalId}:${r.reopenSeq}`;

/** The detector's summary in each finding payload entry, by detector id. */
function summariesByDetector(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const entries: unknown = JSON.parse(payload);
    if (!Array.isArray(entries)) return out;
    for (const e of entries) {
      if (
        e &&
        typeof e === "object" &&
        typeof e.detectorId === "string" &&
        typeof e.summary === "string"
      ) {
        out.set(e.detectorId, e.summary);
      }
    }
  } catch {
    // malformed payload: fall back to signal titles
  }
  return out;
}

/**
 * What a signal RCA job analyses: the hits of this finding whose signals it
 * started or reopened (signal_rcas rows), each with the detector's summary from
 * the finding. An opening is paired with its hit by detector, which a merge or
 * a hand move never changes (a trace has one hit per detector); pairing by the
 * signal would lose a hit moved since. Null when there is nothing to analyse.
 */
export async function loadSignalRcaContext(
  db: RcaDb,
  backend: Pick<SignalsBackend, "traceFindings">,
  findingId: string,
  projectId: string,
): Promise<SignalRcaContext | null> {
  const openings = await db.signalRca.findMany({
    where: { findingId, signal: { projectId } },
    select: {
      signalId: true,
      reopenSeq: true,
      signal: { select: { title: true, detectorId: true } },
    },
    orderBy: { createTime: "asc" },
  });
  if (openings.length === 0) return null;
  const hits = await db.signalHit.findMany({
    where: { findingId, projectId },
    select: { detectorId: true, traceId: true, seenAt: true },
  });
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (hits.length === 0 || !project) return null;

  const traceId = hits[0].traceId;
  const detectors = await db.detector.findMany({
    where: { id: { in: [...new Set(hits.map((h) => h.detectorId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(detectors.map((d) => [d.id, d.name]));
  const finding = (await backend.traceFindings(projectId, traceId)).find(
    (f) => f.finding_id === findingId,
  );
  const summaries = finding ? summariesByDetector(finding.payload) : new Map<string, string>();

  const findings: DetectorRcaFinding[] = [];
  const analysed = new Set<string>();
  for (const o of openings) {
    const hit = hits.find((h) => h.detectorId === o.signal.detectorId);
    // One section per hit, even if merges left two openings for it.
    if (!hit || analysed.has(hit.detectorId)) continue;
    analysed.add(hit.detectorId);
    findings.push({
      detectorId: hit.detectorId,
      detectorName: names.get(hit.detectorId) ?? "deleted detector",
      summary: summaries.get(hit.detectorId) ?? o.signal.title,
      signalTitle: o.signal.title,
    });
  }
  if (findings.length === 0) return null;
  return {
    traceId,
    workspaceId: project.workspaceId,
    findingTimestamp: Math.min(...hits.map((h) => h.seenAt.getTime())),
    findings,
    covered: openings.filter((o) => analysed.has(o.signal.detectorId)).map(openingKey),
  };
}

/** Whether signals were opened for this finding that a finished run did not cover. */
export async function hasUncoveredOpenings(
  db: Pick<PrismaClient, "signalRca">,
  findingId: string,
  covered: readonly string[],
): Promise<boolean> {
  const rows = await db.signalRca.findMany({
    where: { findingId },
    select: { signalId: true, reopenSeq: true },
  });
  const seen = new Set(covered);
  return rows.some((r) => !seen.has(openingKey(r)));
}

/** Close an empty finding only if no analysable opening arrived since the read. */
export async function closeEmptySignalRca(
  db: Pick<PrismaClient, "$transaction">,
  findingId: string,
  projectId: string,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Opening creation updates this same row before inserting its opening.
    // Permit FK checks by a merge carrying a link while serializing the
    // finding's status writes, just as completion does.
    await tx.$queryRaw`SELECT id FROM detector_rcas WHERE finding_id = ${findingId} FOR NO KEY UPDATE`;
    await removeOrphanSignalRcas(tx, findingId);
    const hits = await tx.$queryRaw<{ present: number }[]>`
      SELECT 1 AS present FROM signal_rcas r
      JOIN signals s ON s.id = r.signal_id
      JOIN signal_hits h ON h.finding_id = r.finding_id
        AND h.project_id = s.project_id AND h.detector_id = s.detector_id
      WHERE r.finding_id = ${findingId} AND s.project_id = ${projectId}
      LIMIT 1`;
    if (hits.length > 0) return false;
    await tx.detectorRca.updateMany({
      where: { findingId, projectId, status: "pending" },
      data: { status: "failed", result: "No hit is left to analyse.", completedAt: new Date() },
    });
    return true;
  });
}

/**
 * Re-enqueue signal RCAs still pending well after their job should have run
 * (the enqueue after the assignment commit failed, or the job was lost).
 */
export async function sweepSignalRcas(
  db: Pick<PrismaClient, "signalRca">,
  now: number = Date.now(),
): Promise<number> {
  const stale = await db.signalRca.findMany({
    where: {
      createTime: { gt: new Date(now - WAITING_LOOKBACK_MS), lt: new Date(now - RCA_STALE_MS) },
      rca: { status: "pending" },
    },
    select: { findingId: true, rca: { select: { projectId: true } } },
    distinct: ["findingId"],
    take: 200,
  });
  for (const r of stale) await enqueueSignalRca(r.findingId, r.rca.projectId, 0);
  if (stale.length > 0) console.log(`[Signals] re-enqueued ${stale.length} pending RCA(s)`);
  return stale.length;
}
