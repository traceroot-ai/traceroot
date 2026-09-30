import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  DISMISS_REASONS,
  RESOLVE_REASONS,
  SIGNAL_NOTE_MAX_LENGTH,
  SYSTEM_ACTOR,
  SYSTEM_REOPEN_REASON,
  type SignalStatus,
} from "./constants.ts";
import { lockSignalPartition } from "./partition-lock.ts";

// A blank note is no note; a note is stored trimmed.
const note = z
  .string()
  .trim()
  .max(SIGNAL_NOTE_MAX_LENGTH)
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * A user's status change. Resolving and dismissing take a reason, and a note
 * when the reason is "other"; reopening takes neither.
 */
export const signalStatusChangeSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), reason: z.enum(RESOLVE_REASONS), note }),
    z.object({ status: z.literal("dismissed"), reason: z.enum(DISMISS_REASONS), note }),
    z.object({ status: z.literal("open"), note }),
  ])
  .refine((c) => !("reason" in c) || c.reason !== "other" || c.note !== null, {
    message: 'a note is required when the reason is "other"',
    path: ["note"],
  });

export type SignalStatusChange = z.output<typeof signalStatusChangeSchema>;

export type SetSignalStatusResult =
  | { ok: true; changed: boolean; status: SignalStatus }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "merged"; mergedIntoId: string }
  | { ok: false; code: "conflict"; status: SignalStatus };

/**
 * Apply a user's status change and record it in signal_status_events in the same
 * transaction, under the partition lock, so it cannot interleave with an
 * automatic reopen.
 *
 * `expectedStatus` is the status the user saw when they opened the dialog. If
 * someone (or a new hit) changed it since, nothing is written and the caller
 * gets `conflict` with the current status. Setting the status the signal already
 * has writes nothing and reports `changed: false`.
 */
export async function setSignalStatus(
  db: Pick<PrismaClient, "$transaction">,
  params: {
    projectId: string;
    signalId: string;
    actorUserId: string;
    change: SignalStatusChange;
    expectedStatus?: SignalStatus;
  },
): Promise<SetSignalStatusResult> {
  const { projectId, signalId, actorUserId, change, expectedStatus } = params;
  return db.$transaction(async (tx) => {
    const found = await tx.signal.findFirst({
      where: { id: signalId, projectId },
      select: { detectorId: true },
    });
    if (!found) return { ok: false, code: "not_found" };
    await lockSignalPartition(tx, projectId, found.detectorId);

    // Re-read under the lock: this is the state the write is decided on.
    const current = await tx.signal.findUniqueOrThrow({
      where: { id: signalId },
      select: { status: true, mergedIntoId: true },
    });
    const status = current.status as SignalStatus;
    if (current.mergedIntoId)
      return { ok: false, code: "merged", mergedIntoId: current.mergedIntoId };
    if (expectedStatus !== undefined && status !== expectedStatus) {
      return { ok: false, code: "conflict", status };
    }
    if (status === change.status) return { ok: true, changed: false, status };

    await tx.signal.update({
      where: { id: signalId },
      data: {
        status: change.status,
        resolvedAt: change.status === "resolved" ? new Date() : null,
      },
    });
    await tx.signalStatusEvent.create({
      data: {
        signalId,
        actorUserId,
        fromStatus: status,
        toStatus: change.status,
        reason: "reason" in change ? change.reason : null,
        note: change.note,
      },
    });
    return { ok: true, changed: true, status: change.status };
  });
}

/**
 * The reopen rule: a hit reopens a resolved signal only if its trace started
 * after the signal was resolved, so traces already in flight at resolve time do
 * not undo the resolve. Dismissed signals never reopen; their hits count silently.
 */
export function hitReopensSignal(
  signal: { status: string; resolvedAt: Date | null },
  traceStartTime: Date,
): boolean {
  return (
    signal.status === "resolved" &&
    signal.resolvedAt !== null &&
    traceStartTime.getTime() > signal.resolvedAt.getTime()
  );
}

/**
 * Reopen a resolved signal for a new hit, inside the caller's transaction, which
 * must already hold the partition lock. Bumps reopenSeq (a new opening: RCA and
 * the digest key off it) and records the change with the system actor.
 *
 * @returns the new reopenSeq
 */
export async function reopenSignalForHit(
  tx: Pick<Prisma.TransactionClient, "signal" | "signalStatusEvent">,
  signalId: string,
): Promise<number> {
  const updated = await tx.signal.update({
    where: { id: signalId },
    data: { status: "open", resolvedAt: null, reopenSeq: { increment: 1 } },
    select: { reopenSeq: true },
  });
  await tx.signalStatusEvent.create({
    data: {
      signalId,
      actorUserId: SYSTEM_ACTOR,
      fromStatus: "resolved",
      toStatus: "open",
      reason: SYSTEM_REOPEN_REASON,
      note: null,
    },
  });
  return updated.reopenSeq;
}
