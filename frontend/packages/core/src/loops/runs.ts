/** Run rows: creation with a per-Loop sequence, and the rules around one active run. */
import type { LoopRun, Prisma } from "@prisma/client";
import {
  ACTIVE_RUN_STATUSES,
  type LoopRunDto,
  type LoopRunStatus,
  type LoopRunTrigger,
} from "./contracts.ts";

export function runToDto(run: LoopRun): LoopRunDto {
  return {
    id: run.id,
    loopId: run.loopId,
    seq: run.seq,
    trigger: run.trigger as LoopRunTrigger,
    slotAt: run.slotAt?.toISOString() ?? null,
    status: run.status as LoopRunStatus,
    attempts: run.attempts,
    sessionId: run.sessionId,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    summary: run.summary,
    findingKeys: run.findingKeys,
    tracesRead: run.tracesRead,
    error: run.error,
    metadata: (run.metadata as Record<string, unknown> | null) ?? null,
    costUsd: run.costUsd === null ? null : Number(run.costUsd),
    createTime: run.createTime.toISOString(),
  };
}

/**
 * Insert a run with the next sequence number of its Loop. The Loop row is
 * locked for the insert, so two concurrent creates take different numbers
 * (the unique index on loop and seq is the backstop, not the mechanism).
 */
export async function createRun(
  tx: Prisma.TransactionClient,
  input: {
    loopId: string;
    projectId: string;
    trigger: LoopRunTrigger;
    slotAt?: Date | null;
    status?: LoopRunStatus;
    data?: Partial<Omit<Prisma.LoopRunUncheckedCreateInput, "loopId" | "projectId" | "seq">>;
  },
): Promise<LoopRun> {
  await tx.$queryRaw`SELECT id FROM loops WHERE id = ${input.loopId} FOR UPDATE`;
  const last = await tx.loopRun.aggregate({
    where: { loopId: input.loopId },
    _max: { seq: true },
  });
  return tx.loopRun.create({
    data: {
      ...input.data,
      loopId: input.loopId,
      projectId: input.projectId,
      seq: (last._max.seq ?? 0) + 1,
      trigger: input.trigger,
      slotAt: input.slotAt ?? null,
      status: input.status ?? "pending",
    },
  });
}

export async function hasActiveRun(db: Prisma.TransactionClient, loopId: string): Promise<boolean> {
  const active = await db.loopRun.findFirst({
    where: { loopId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return active !== null;
}
