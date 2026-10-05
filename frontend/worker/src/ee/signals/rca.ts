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
import { RCA_STALE_MS, WAITING_LOOKBACK_MS } from "./config.js";

let rcaQueue: Queue<RcaJob> | null = null;
function getRcaQueue(): Queue<RcaJob> {
  rcaQueue ??= new Queue<RcaJob>(DETECTOR_RCA_QUEUE, { connection: createRedisConnection() });
  return rcaQueue;
}

/**
 * Enqueue the RCA of a finding whose hit started or reopened a signal, once
 * every hit of the trace is settled (startSettledRcas). One job per finding;
 * the job reads the signals to analyse when it runs. Finished and failed jobs
 * are removed at once: a kept job would swallow the add of a later opening
 * under the same id. The id prefix differs from per-finding RCA jobs from
 * before signals, so one of those still kept cannot swallow it either.
 */
export async function enqueueSignalRca(
  findingId: string,
  projectId: string,
  delayMs: number = 0,
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

/**
 * The findings among `findingIds` whose hits are all settled, so their RCA can
 * analyse every signal the trace started or reopened in one run. A hit is
 * settled once it is assigned (in Postgres, or its ClickHouse copy) or given
 * up. A hit of a detector deleted since, or with signals or RCA off, is not
 * waited for, nor one detected before signals were turned on: none of them
 * will open a signal to analyse. Hits older than the lookback are not read,
 * as the assignment job does not read them either.
 */
export async function settledFindings(
  db: Pick<PrismaClient, "signalHit" | "detector">,
  backend: Pick<SignalsBackend, "unsettledRuns">,
  projectId: string,
  findingIds: readonly string[],
  now: number = Date.now(),
): Promise<Set<string>> {
  if (findingIds.length === 0) return new Set();
  const runs = await backend.unsettledRuns(projectId, [...findingIds], now - WAITING_LOOKBACK_MS);
  if (runs.length === 0) return new Set(findingIds);
  const [assigned, detectors] = await Promise.all([
    db.signalHit.findMany({
      where: { runId: { in: runs.map((r) => r.run_id) } },
      select: { runId: true },
    }),
    db.detector.findMany({
      where: { projectId, id: { in: [...new Set(runs.map((r) => r.detector_id))] } },
      select: { id: true, enableSignals: true, enableRca: true, signalsEnabledAt: true },
    }),
  ]);
  const done = new Set(assigned.map((h) => h.runId));
  const byId = new Map(detectors.map((d) => [d.id, d]));
  const waiting = new Set<string>();
  for (const r of runs) {
    const d = byId.get(r.detector_id);
    if (done.has(r.run_id) || !d?.enableSignals || !d.enableRca) continue;
    if (r.timestamp_ms < d.signalsEnabledAt.getTime()) continue;
    waiting.add(r.finding_id);
  }
  return new Set(findingIds.filter((f) => !waiting.has(f)));
}

/**
 * Start the RCA of each finding among `findingIds` that has one pending and
 * whose hits are all settled. Called when an assignment round ends, for the
 * findings of the hits it settled, and by the sweeper. Starting a finding
 * whose job is already waiting or running changes nothing (one job id per
 * finding). Returns how many it started.
 */
export async function startSettledRcas(
  db: Pick<PrismaClient, "detectorRca" | "signalHit" | "detector">,
  backend: Pick<SignalsBackend, "unsettledRuns">,
  projectId: string,
  findingIds: readonly string[],
  enqueue: (findingId: string, projectId: string) => Promise<void> = enqueueSignalRca,
): Promise<number> {
  if (findingIds.length === 0) return 0;
  const pending = await db.detectorRca.findMany({
    where: {
      findingId: { in: [...findingIds] },
      projectId,
      status: "pending",
      signalRcas: { some: {} },
    },
    select: { findingId: true },
  });
  if (pending.length === 0) return 0;
  const settled = await settledFindings(
    db,
    backend,
    projectId,
    pending.map((p) => p.findingId),
  );
  for (const findingId of settled) await enqueue(findingId, projectId);
  return settled.size;
}

export interface SignalRcaContext {
  traceId: string;
  workspaceId: string;
  /** Detection time of the earliest hit analysed; keys the per-finding digest window. */
  findingTimestamp: number;
  /** One entry per hit to analyse, with its signal's title. */
  findings: DetectorRcaFinding[];
  /** The signal openings this run covers, as "signalId:reopenSeq". */
  covered: string[];
  /** The detector whose hit each covered opening is; its section is that detector's place in `findings`. */
  coveredDetectors: Record<string, string>;
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
  const coveredOpenings = openings.filter((o) => analysed.has(o.signal.detectorId));
  return {
    traceId,
    workspaceId: project.workspaceId,
    findingTimestamp: Math.min(...hits.map((h) => h.seenAt.getTime())),
    findings,
    covered: coveredOpenings.map(openingKey),
    coveredDetectors: Object.fromEntries(
      coveredOpenings.map((o) => [openingKey(o), o.signal.detectorId]),
    ),
  };
}

/**
 * The root cause a signal RCA gave for each covered opening: the "Root cause:"
 * line of its hit's section. Sections are taken by position, in the order the
 * prompt listed the hits, never by detector name, since one name can contain
 * another and two detectors can share a name. An answer without one section
 * per hit gives no root cause for any of them, rather than a misaligned one.
 */
export function rootCausesByOpening(
  result: string,
  context: Pick<SignalRcaContext, "findings" | "covered" | "coveredDetectors">,
): { opening: string; rootCause: string | null }[] {
  const sections = result.split(/\n(?=#{2,4}\s)/).filter((s) => /^#{2,4}\s/.test(s));
  // A single hit may be answered without a heading; its root cause is the answer's.
  const bodies =
    context.findings.length === 1 && sections.length === 0
      ? [result]
      : sections.length === context.findings.length
        ? sections
        : null;
  return context.covered.map((opening) => {
    const index = context.findings.findIndex(
      (f) => f.detectorId === context.coveredDetectors[opening],
    );
    const body = bodies && index >= 0 ? bodies[index] : null;
    return { opening, rootCause: body ? rootCauseOf(body) : null };
  });
}

function rootCauseOf(section: string): string | null {
  const match = section.match(/root cause:\**\s*(.+)/i);
  return match ? match[1].replace(/\*+/g, "").trim() || null : null;
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
 * (the enqueue after the assignment commit failed, the job was lost, or the
 * trace's last hit was settled by its detector being switched off), once the
 * trace's hits are all settled.
 */
export async function sweepSignalRcas(
  db: Pick<PrismaClient, "signalRca" | "detectorRca" | "signalHit" | "detector">,
  backend: Pick<SignalsBackend, "unsettledRuns">,
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
  const byProject = new Map<string, string[]>();
  for (const r of stale) {
    byProject.set(r.rca.projectId, [...(byProject.get(r.rca.projectId) ?? []), r.findingId]);
  }
  let started = 0;
  for (const [projectId, findingIds] of byProject) {
    started += await startSettledRcas(db, backend, projectId, findingIds);
  }
  if (started > 0) console.log(`[Signals] re-enqueued ${started} pending RCA(s)`);
  return started;
}
