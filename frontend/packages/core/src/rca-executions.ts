import { createHash } from "node:crypto";
import type { PrismaClient, TraceStatus } from "@prisma/client";

/** First attempt's trace id IS the finding id (dashless); later attempts hash (finding, attempt). */
export function executionTraceId(findingId: string, attempt: number): string {
  if (attempt === 1) return findingId.replaceAll("-", "");
  return createHash("sha256").update(`${findingId}:${attempt}`).digest("hex").slice(0, 32);
}

type Db = Pick<PrismaClient, "$transaction" | "$queryRaw" | "detectorRcaExecution" | "detectorRca">;

/**
 * Allocate the next execution for a finding BEFORE the agent runs. Runs in a
 * transaction holding the finding's DetectorRca row lock, so two concurrent
 * allocations get attempts n and n+1 — never the same trace id.
 */
export async function allocateExecution(
  db: Db,
  params: { findingId: string; projectId: string },
): Promise<{ executionId: string; attempt: number; traceId: string }> {
  return db.$transaction(async (tx) => {
    // Row lock: the DetectorRca row must exist (the run processor pre-seeds it).
    await tx.$queryRaw`SELECT id FROM detector_rcas WHERE finding_id = ${params.findingId} FOR UPDATE`;
    const agg = await tx.detectorRcaExecution.aggregate({
      where: { findingId: params.findingId },
      _max: { attempt: true },
    });
    let maxAttempt = agg._max.attempt ?? 0;
    if (maxAttempt === 0) {
      // Lazy seed for findings whose RCA ran before executions existed (no backfill by
      // design): record that historical run as attempt 1 — untraced — so this allocation
      // becomes attempt 2 and the attempt-1 = finding-id convention holds for old data.
      const legacy = await tx.detectorRca.findUnique({
        where: { findingId: params.findingId },
        select: {
          status: true,
          sessionId: true,
          result: true,
          createTime: true,
          completedAt: true,
          latestExecutionId: true,
        },
      });
      if (
        legacy &&
        legacy.latestExecutionId === null &&
        (legacy.status === "done" || legacy.status === "failed")
      ) {
        await tx.detectorRcaExecution.create({
          data: {
            findingId: params.findingId,
            projectId: params.projectId,
            attempt: 1,
            traceId: executionTraceId(params.findingId, 1),
            traceStatus: "disabled",
            sessionId: legacy.sessionId,
            result: legacy.result,
            startedAt: legacy.createTime,
            finishedAt: legacy.completedAt,
          },
        });
        maxAttempt = 1;
      }
    }
    const attempt = maxAttempt + 1;
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

/** Compare-and-set: point the finding at this execution only if it is newer than the current one. */
export async function advanceLatest(
  db: Db,
  params: { findingId: string; executionId: string; attempt: number },
): Promise<boolean> {
  const current = await db.detectorRca.findUnique({
    where: { findingId: params.findingId },
    select: { latestExecutionId: true, latestExecution: { select: { attempt: true } } },
  });
  const currentAttempt = current?.latestExecution?.attempt ?? 0;
  if (params.attempt <= currentAttempt) return false;
  const res = await db.detectorRca.updateMany({
    where: { findingId: params.findingId, latestExecutionId: current?.latestExecutionId ?? null },
    data: { latestExecutionId: params.executionId },
  });
  return res.count === 1;
}

export async function setExecutionTraceStatus(
  db: Pick<PrismaClient, "detectorRcaExecution">,
  executionId: string,
  status: TraceStatus,
): Promise<void> {
  await db.detectorRcaExecution.update({
    where: { id: executionId },
    data: { traceStatus: status },
  });
}

/**
 * Whether `executionId` is still the finding's latest execution.
 *
 * A finding row is shared by every attempt, so only the current one may write
 * its status — otherwise a slow older attempt finishing last overwrites a newer
 * attempt's result. The success path enforces this through advanceLatest's
 * compare-and-set; failure paths, which write the finding directly, ask here.
 */
export async function isLatestExecution(
  db: Db,
  findingId: string,
  executionId: string,
): Promise<boolean> {
  const current = await db.detectorRca.findUnique({
    where: { findingId },
    select: { latestExecutionId: true },
  });
  // No pointer yet means nothing newer has claimed the finding: this attempt,
  // the only one to have finished, speaks for it.
  return current?.latestExecutionId == null || current.latestExecutionId === executionId;
}
