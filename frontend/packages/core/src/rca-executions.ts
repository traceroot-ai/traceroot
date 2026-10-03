import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

/** Caller holds the finding row lock shared with signal opening creation. */
export async function removeOrphanSignalRcas(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  findingId: string,
): Promise<void> {
  // Match by detector, not signal: moving a hit preserves its RCA evidence.
  // Remove only links with no evidence left, so they cannot inherit another
  // detector's section when this shared finding completes.
  await tx.$executeRaw`
    DELETE FROM signal_rcas r USING signals s
    WHERE r.signal_id = s.id AND r.finding_id = ${findingId}
      AND NOT EXISTS (
        SELECT 1 FROM signal_hits h WHERE h.finding_id = r.finding_id
          AND h.project_id = s.project_id AND h.detector_id = s.detector_id
      )`;
}

/** First attempt's trace id IS the finding id (dashless); later attempts hash (finding, attempt). */
export function executionTraceId(findingId: string, attempt: number): string {
  if (attempt === 1) return findingId.replaceAll("-", "");
  return createHash("sha256").update(`${findingId}:${attempt}`).digest("hex").slice(0, 32);
}

/**
 * Allocate the next execution for a finding BEFORE the agent runs. Runs in a
 * transaction holding the finding's DetectorRca row lock, so two concurrent
 * allocations get attempts n and n+1 — never the same trace id.
 */
export async function allocateExecution(
  db: Pick<PrismaClient, "$transaction" | "$queryRaw" | "detectorRcaExecution">,
  params: { findingId: string; projectId: string },
): Promise<{ executionId: string; attempt: number; traceId: string }> {
  return db.$transaction(async (tx) => {
    // Row lock: the DetectorRca row must exist (the run processor pre-seeds it).
    await tx.$queryRaw`SELECT id FROM detector_rcas WHERE finding_id = ${params.findingId} FOR UPDATE`;
    const agg = await tx.detectorRcaExecution.aggregate({
      where: { findingId: params.findingId },
      _max: { attempt: true },
    });
    const attempt = (agg._max.attempt ?? 0) + 1;
    const traceId = executionTraceId(params.findingId, attempt);
    const row = await tx.detectorRcaExecution.create({
      data: {
        findingId: params.findingId,
        projectId: params.projectId,
        attempt,
        traceId,
        traceStatus: "pending",
      },
    });
    return { executionId: row.id, attempt, traceId };
  });
}

/**
 * Write the finding's terminal state, but only while this attempt is still the
 * current one — i.e. no execution with a higher attempt exists.
 *
 * The finding row is shared by every attempt, so a slow older attempt finishing
 * after a newer one was allocated (BullMQ stalled-lock redelivery) must not
 * overwrite the newer attempt's state. The check runs under the same
 * DetectorRca row lock allocateExecution takes: a retry being allocated
 * concurrently has either committed before the lock is granted here (and so
 * is visible to the guard) or waits until this transaction ends. Without the
 * lock, a single conditional UPDATE would evaluate its guard against a snapshot
 * taken before that commit and let the older result overwrite the retry.
 *
 * @returns whether the write applied — false means a newer attempt owns the
 *   finding and this outcome belongs only to its own execution row.
 */
export async function finishFindingIfLatest(
  db: Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw">,
  params: {
    findingId: string;
    attempt: number;
    status: "done" | "failed";
    result?: string | null;
    completedAt?: Date;
    /** Signal openings actually analysed; omitted for legacy per-finding jobs. */
    coveredOpenings?: readonly string[];
    /**
     * For a successful signal RCA: each analysed opening ("signalId:reopenSeq")
     * with the root cause given for its hit. The answer is kept on each opening.
     */
    openingResults?: readonly { opening: string; rootCause: string | null }[];
    /** The agent session that produced a successful answer, kept with it. */
    sessionId?: string | null;
  },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Serialize status writes without blocking FK checks when a merge
    // carries an RCA link; a stronger lock would invert finding/link locks.
    await tx.$queryRaw`SELECT id FROM detector_rcas WHERE finding_id = ${params.findingId} FOR NO KEY UPDATE`;
    // Opening creation updates this same finding row before inserting its
    // signal_rcas row. Holding the row lock makes coverage and completion one
    // atomic decision, including when this was the final failed attempt.
    let uncovered = false;
    if (params.coveredOpenings) {
      await removeOrphanSignalRcas(tx, params.findingId);
      const openings = await tx.$queryRaw<{ signalId: string; reopenSeq: number }[]>`
        SELECT signal_id AS "signalId", reopen_seq AS "reopenSeq"
        FROM signal_rcas WHERE finding_id = ${params.findingId}`;
      const covered = new Set(params.coveredOpenings);
      uncovered = openings.some((o) => !covered.has(`${o.signalId}:${o.reopenSeq}`));
    }
    const count = await tx.$executeRaw`
      UPDATE detector_rcas
      SET status = ${uncovered ? "pending" : params.status},
          result = ${uncovered ? null : (params.result ?? null)},
          completed_at = ${uncovered ? null : (params.completedAt ?? new Date())}
      WHERE finding_id = ${params.findingId}
        AND NOT EXISTS (
          SELECT 1 FROM detector_rca_executions
          WHERE finding_id = ${params.findingId} AND attempt > ${params.attempt}
        )`;
    // The finding row only holds the latest attempt, which a later signal on
    // the same trace resets and may fail. Each opening the successful run
    // analysed keeps its own copy of the answer, so no later attempt takes it
    // away, and an opening this run did not cover never borrows it.
    if (count === 1 && params.status === "done" && params.openingResults) {
      for (const { opening, rootCause } of params.openingResults) {
        const at = opening.indexOf(":");
        await tx.$executeRaw`
          UPDATE signal_rcas
          SET result = ${params.result ?? null}, root_cause = ${rootCause},
              session_id = ${params.sessionId ?? null}
          WHERE finding_id = ${params.findingId}
            AND signal_id = ${opening.slice(0, at)}
            AND reopen_seq = ${Number(opening.slice(at + 1))}`;
      }
    }
    return count === 1;
  });
}

/**
 * Flip the finding to `running` for this attempt, but only while no higher
 * attempt exists. A superseded attempt (a stalled job redelivered after its
 * retry was allocated) must not drag a finding the newer attempt already
 * finished back to `running`.
 *
 * One conditional UPDATE, no row lock: unlike finishFindingIfLatest a lost
 * race here is harmless — a retry allocated after the guard's snapshot writes
 * its own `running` and then its own terminal state, both later than this.
 *
 * @returns whether the write applied — false means a newer attempt owns the finding.
 */
export async function markFindingRunningIfLatest(
  db: Pick<PrismaClient, "detectorRca">,
  params: { findingId: string; projectId: string; attempt: number },
): Promise<boolean> {
  const res = await db.detectorRca.updateMany({
    where: {
      findingId: params.findingId,
      executions: { none: { attempt: { gt: params.attempt } } },
    },
    data: { status: "running", projectId: params.projectId },
  });
  return res.count === 1;
}
