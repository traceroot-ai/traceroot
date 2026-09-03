import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

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
  },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM detector_rcas WHERE finding_id = ${params.findingId} FOR UPDATE`;
    const count = await tx.$executeRaw`
      UPDATE detector_rcas
      SET status = ${params.status},
          result = ${params.result ?? null},
          completed_at = ${params.completedAt ?? new Date()}
      WHERE finding_id = ${params.findingId}
        AND NOT EXISTS (
          SELECT 1 FROM detector_rca_executions
          WHERE finding_id = ${params.findingId} AND attempt > ${params.attempt}
        )`;
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
