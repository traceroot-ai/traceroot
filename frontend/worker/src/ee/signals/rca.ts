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
import {
  RCA_DELAY_MS,
  RCA_ENQUEUE_GRACE_MS,
  RCA_SWEEP_EXAMINE_CAP,
  RCA_SWEEP_PAGE_SIZE,
  RCA_SWEEP_START_CAP,
  WAITING_LOOKBACK_MS,
} from "./config.js";

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

/** A pending signal RCA stuck with no job past the lookback gets this as its failure. */
export const RCA_SWEEP_TIMEOUT_RESULT = "The analysis did not start in time.";

type SweepCursor = { createTime: Date; signalId: string; reopenSeq: number };

/** Rows strictly after `cursor` in the sweep's (createTime, signalId, reopenSeq) desc order. */
function pastCursor(cursor: SweepCursor) {
  return [
    { createTime: { lt: cursor.createTime } },
    { createTime: cursor.createTime, signalId: { lt: cursor.signalId } },
    {
      createTime: cursor.createTime,
      signalId: cursor.signalId,
      reopenSeq: { lt: cursor.reopenSeq },
    },
  ];
}

/**
 * Start the signal RCAs that are pending without a job: the enqueue after the
 * assignment commit failed, the job was lost, or a user asked for the RCA from
 * the Signals page. A pending RCA whose job is waiting or running is left to it.
 *
 * Pages newest-first past rows that already have a job instead of stopping at
 * the first page, so a busy queue (many recent, legitimately-running requests)
 * can never hide an older, job-less one behind it. Work is bounded by how many
 * RCAs this call actually starts, not by how many rows it had to page through
 * to find them; the latter still has a generous cap, logged when hit, so one
 * sweep cannot scan the whole table. A request this old with still no job has
 * outlived any plausible lost-job window, so instead of paging past it forever
 * it is given an explicit end: marked failed (only while still pending, so a
 * job that started just as this ran is not overwritten), which lets the panel
 * show it failed and requestSignalRca's retry path re-arm it.
 */
export async function sweepSignalRcas(
  db: Pick<PrismaClient, "signalRca" | "detectorRca">,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - RCA_ENQUEUE_GRACE_MS);
  const giveUpBefore = new Date(now - WAITING_LOOKBACK_MS);
  const seenFindings = new Set<string>();
  let started = 0;
  let failed = 0;
  let examined = 0;
  let cursor: SweepCursor | undefined;

  while (examined < RCA_SWEEP_EXAMINE_CAP) {
    const page = await db.signalRca.findMany({
      where: {
        createTime: { lt: cutoff },
        rca: { status: "pending" },
        ...(cursor ? { OR: pastCursor(cursor) } : {}),
      },
      select: {
        signalId: true,
        reopenSeq: true,
        findingId: true,
        createTime: true,
        rca: { select: { projectId: true } },
      },
      // Tie-broken by the primary key so a page boundary never repeats or skips a row.
      orderBy: [{ createTime: "desc" }, { signalId: "desc" }, { reopenSeq: "desc" }],
      take: RCA_SWEEP_PAGE_SIZE,
    });
    if (page.length === 0) break;
    examined += page.length;
    cursor = page[page.length - 1];

    for (const r of page) {
      // One finding can own several openings (one per detector hit on the same
      // trace); they share one job and one detector_rcas row.
      if (seenFindings.has(r.findingId)) continue;
      seenFindings.add(r.findingId);
      if (await getRcaQueue().getJob(signalRcaJobId(r.findingId))) continue;
      if (r.createTime.getTime() < giveUpBefore.getTime()) {
        const res = await db.detectorRca.updateMany({
          where: { findingId: r.findingId, status: "pending" },
          data: { status: "failed", result: RCA_SWEEP_TIMEOUT_RESULT, completedAt: new Date() },
        });
        failed += res.count;
        continue;
      }
      // The cap bounds queue adds only; ending a stale request stays cheap.
      if (started >= RCA_SWEEP_START_CAP) continue;
      await enqueueSignalRca(r.findingId, r.rca.projectId, 0);
      started++;
    }
    if (page.length < RCA_SWEEP_PAGE_SIZE) break;
  }

  if (examined >= RCA_SWEEP_EXAMINE_CAP) {
    console.log(`[Signals] RCA sweep stopped after examining ${examined} row(s)`);
  }
  if (failed > 0) {
    console.log(`[Signals] failed ${failed} pending RCA(s) stuck past the lookback with no job`);
  }
  if (started > 0) console.log(`[Signals] started ${started} pending RCA(s) without a job`);
  return started;
}
