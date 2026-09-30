import type { Prisma, PrismaClient } from "@traceroot/core";
import { hitReopensSignal, lockSignalPartition, reopenSignalForHit } from "@traceroot/core/signals";
import { RCA_COOLDOWN_MS } from "./config.js";
import type { SignalText } from "./types.js";

/** A hit waiting for assignment, as the job read it from ClickHouse. */
export interface WaitingHit {
  runId: string;
  projectId: string;
  detectorId: string;
  traceId: string;
  findingId: string;
  /** When the detector fired (the detector_runs timestamp). */
  seenAt: Date;
  /** Start of the hit's trace, for the reopen rule; the detection time when unknown. */
  traceStartTime: Date;
  summary: string;
  data: unknown;
  /** Set for hits grouped without the assignment model (Jev-path hits: their category). */
  groupKey: string | null;
}

/** Where the decision put the hit. */
export type Placement =
  | { kind: "attach"; signalId: string; score: number | null; criteriaVersion: number }
  | { kind: "create"; signal: SignalText; anchorText: string; anchorEmbedding: number[] }
  | { kind: "group"; groupKey: string; signal: SignalText; anchorText: string };

export type AssignmentOutcome = "created" | "attached" | "reopened" | "duplicate";

export interface AssignmentResult {
  outcome: AssignmentOutcome;
  signalId: string;
  /** The signal's opening this hit belongs to (reopen_seq after the write). */
  reopenSeq: number;
  /** What signal_hits holds for the hit, copied to ClickHouse. */
  score: number | null;
  criteriaVersion: number | null;
  assignedAt: Date;
  /** Set when this hit's opening of the signal needs an RCA: the finding to analyse. */
  rcaFindingId: string | null;
}

/** Merge chains are short; a longer one means a cycle, which merges must never create. */
const MAX_MERGE_HOPS = 10;

type Tx = Prisma.TransactionClient;

const TARGET_SELECT = {
  id: true,
  status: true,
  resolvedAt: true,
  reopenSeq: true,
  firstSeenAt: true,
  lastSeenAt: true,
  mergedIntoId: true,
} as const;

async function followMerges(tx: Tx, signalId: string) {
  let id = signalId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const signal = await tx.signal.findUnique({ where: { id }, select: TARGET_SELECT });
    if (!signal || !signal.mergedIntoId) return { signal, followed: hop > 0 };
    id = signal.mergedIntoId;
  }
  throw new Error(`signal ${signalId}: merge chain longer than ${MAX_MERGE_HOPS}`);
}

/**
 * Record one hit's assignment in Postgres: the short write under the partition
 * lock. No model call happens here. In one transaction: return the existing
 * assignment of a hit already recorded (a re-run job, or a hit whose ClickHouse
 * copy failed), follow a merge made since the decision, attach or reopen or
 * create, and record the hit.
 */
export async function applyAssignment(
  db: Pick<PrismaClient, "$transaction">,
  hit: WaitingHit,
  placement: Placement,
  opts: { rca: boolean; now?: number },
): Promise<AssignmentResult> {
  return db.$transaction(async (tx) => {
    await lockSignalPartition(tx, hit.projectId, hit.detectorId);

    const done = await tx.signalHit.findUnique({
      where: { runId: hit.runId },
      select: {
        score: true,
        criteriaVersion: true,
        assignedAt: true,
        signal: { select: { id: true, reopenSeq: true } },
      },
    });
    if (done) {
      return {
        outcome: "duplicate",
        signalId: done.signal.id,
        reopenSeq: done.signal.reopenSeq,
        score: done.score,
        criteriaVersion: done.criteriaVersion,
        assignedAt: done.assignedAt,
        rcaFindingId: null,
      };
    }

    let target: Awaited<ReturnType<typeof followMerges>>["signal"] = null;
    let criteriaVersion: number | null = null;
    let score: number | null = null;
    if (placement.kind === "attach") {
      const found = await followMerges(tx, placement.signalId);
      if (!found.signal) throw new Error(`signal ${placement.signalId} vanished before the write`);
      target = found.signal;
      // After a merge the hit was judged against another signal's criteria.
      criteriaVersion = found.followed ? null : placement.criteriaVersion;
      score = found.followed ? null : placement.score;
    } else if (placement.kind === "group") {
      const grouped = await tx.signal.findFirst({
        where: {
          projectId: hit.projectId,
          detectorId: hit.detectorId,
          groupKey: placement.groupKey,
        },
        select: { id: true },
      });
      if (grouped) target = (await followMerges(tx, grouped.id)).signal;
    }

    let outcome: AssignmentOutcome;
    let signalId: string;
    let reopenSeq: number;
    if (target) {
      signalId = target.id;
      reopenSeq = target.reopenSeq;
      outcome = "attached";
      if (hitReopensSignal(target, hit.traceStartTime)) {
        reopenSeq = await reopenSignalForHit(tx, target.id);
        outcome = "reopened";
      }
      await tx.signal.update({
        where: { id: target.id },
        data: {
          hitCount: { increment: 1 },
          firstSeenAt: hit.seenAt < target.firstSeenAt ? hit.seenAt : target.firstSeenAt,
          lastSeenAt: hit.seenAt > target.lastSeenAt ? hit.seenAt : target.lastSeenAt,
        },
      });
    } else {
      // Unreachable: an attach either found its target or threw above.
      if (placement.kind === "attach") throw new Error("attach without a target");
      const created = await tx.signal.create({
        data: {
          projectId: hit.projectId,
          detectorId: hit.detectorId,
          title: placement.signal.title,
          criteriaCovers: placement.signal.covers,
          criteriaExcludes: placement.signal.excludes,
          anchorText: placement.anchorText,
          anchorEmbedding: placement.kind === "create" ? placement.anchorEmbedding : [],
          groupKey: placement.kind === "group" ? placement.groupKey : null,
          hitCount: 1,
          firstSeenAt: hit.seenAt,
          lastSeenAt: hit.seenAt,
        },
        select: { id: true, criteriaVersion: true },
      });
      signalId = created.id;
      reopenSeq = 0;
      // A category signal's hits are never judged against its criteria.
      criteriaVersion = placement.kind === "create" ? created.criteriaVersion : null;
      outcome = "created";
    }

    // RCA follows signals: a hit that creates or reopens a signal gets one,
    // unless the detector has RCA off or the signal's last RCA is recent.
    let rcaFindingId: string | null = null;
    if (opts.rca && (outcome === "created" || outcome === "reopened")) {
      const last = await tx.signalRca.findFirst({
        where: { signalId },
        orderBy: { createTime: "desc" },
        select: { createTime: true },
      });
      const now = opts.now ?? Date.now();
      if (!last || now - last.createTime.getTime() >= RCA_COOLDOWN_MS) {
        // Status is left alone on an existing row: only the RCA job's latest
        // attempt writes it.
        await tx.detectorRca.upsert({
          where: { findingId: hit.findingId },
          create: { findingId: hit.findingId, projectId: hit.projectId, status: "pending" },
          update: { projectId: hit.projectId },
        });
        await tx.signalRca.create({ data: { signalId, reopenSeq, findingId: hit.findingId } });
        rcaFindingId = hit.findingId;
      }
    }

    const recorded = await tx.signalHit.create({
      data: {
        runId: hit.runId,
        signalId,
        projectId: hit.projectId,
        detectorId: hit.detectorId,
        traceId: hit.traceId,
        findingId: hit.findingId,
        seenAt: hit.seenAt,
        score,
        criteriaVersion,
      },
      select: { assignedAt: true },
    });
    return {
      outcome,
      signalId,
      reopenSeq,
      score,
      criteriaVersion,
      assignedAt: recorded.assignedAt,
      rcaFindingId,
    };
  });
}
