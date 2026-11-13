/**
 * The trusted-caller write for a signal's status: what the public API (and any
 * future agent binding) calls through /api/internal/write/signals/[id]/status.
 *
 * It applies the same change as the web route — core `setSignalStatus`, which
 * records the status event (actor, reason, note) under the partition lock — with
 * one narrower rule: only "resolved" and "open" are settable here. A dismissed
 * signal never reopens on a new hit (see `hitReopensSignal`), so a script or an
 * agent that dismisses a real problem by mistake would hide it for good;
 * dismissing stays a decision a person makes in the web app.
 */
import { prisma } from "@traceroot/core";
import {
  SIGNAL_STATUSES,
  setSignalStatus,
  signalStatusChangeSchema,
  type SignalStatus,
} from "@traceroot/core/signals";
import { z } from "zod";
import { writeAudit, type AuditEntry } from "@/lib/write-services/audit";
import { requireProjectMember } from "@/lib/write-services/project-access";
import type { Provenance, UpdateResult } from "@/lib/write-services/types";

export const DISMISS_NOT_ALLOWED_MESSAGE =
  'status must be "resolved" or "open"; dismiss a signal in the web app';
export const SIGNAL_NOT_FOUND_MESSAGE = "Signal not found";

/** The signal as the write answers it: enough to confirm the new state. */
export interface SignalStatusRecord {
  id: string;
  projectId: string;
  detectorId: string;
  title: string;
  status: SignalStatus;
  resolvedAt: string | null;
  reopenCount: number;
}

const expectedStatusSchema = z.enum(SIGNAL_STATUSES).optional();

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Set a signal's status for a MEMBER of its project. `change` is
 * `{ status, reason?, note? }` as the web route takes it; `expectedStatus`, when
 * sent, is the status the caller last read, and a different current status is
 * a 409 that writes nothing.
 */
export async function changeSignalStatus(input: {
  actorUserId: string;
  projectId: string;
  signalId: string;
  change: unknown;
  expectedStatus?: unknown;
  provenance: Provenance;
}): Promise<UpdateResult<SignalStatusRecord>> {
  const { projectId, signalId, actorUserId } = input;

  const access = await prisma.$transaction((tx) =>
    requireProjectMember(tx, projectId, actorUserId),
  );
  if (!access.ok) return access;

  const requested = (input.change as { status?: unknown } | null)?.status;
  if (requested === "dismissed") {
    return { ok: false, status: 400, error: DISMISS_NOT_ALLOWED_MESSAGE };
  }
  const change = signalStatusChangeSchema.safeParse(input.change);
  if (!change.success) return { ok: false, status: 400, error: firstIssue(change.error) };
  const expected = expectedStatusSchema.safeParse(input.expectedStatus);
  if (!expected.success) {
    return { ok: false, status: 400, error: `expectedStatus: ${expected.error.issues[0].message}` };
  }

  const result = await setSignalStatus(prisma, {
    projectId,
    signalId,
    actorUserId,
    change: change.data,
    expectedStatus: expected.data,
  });
  if (!result.ok) {
    if (result.code === "not_found") {
      return { ok: false, status: 404, error: SIGNAL_NOT_FOUND_MESSAGE };
    }
    if (result.code === "merged") {
      return {
        ok: false,
        status: 409,
        error: `Signal was merged into ${result.mergedIntoId}; change that signal instead`,
      };
    }
    return {
      ok: false,
      status: 409,
      error: `The signal's status changed: it is now "${result.status}"`,
    };
  }

  const signal = result.signal;

  const changed = result.changed ? ["status"] : [];
  if (result.changed) {
    const audit: AuditEntry = {
      actorUserId,
      operation: "set_signal_status",
      resourceType: "signal",
      resourceId: signalId,
      workspaceId: access.workspaceId,
      projectId,
      summary: {
        changed,
        status: change.data.status,
        ...("reason" in change.data ? { reason: change.data.reason } : {}),
      },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    };
    await writeAudit(prisma, audit);
  }

  return {
    ok: true,
    changed,
    data: {
      id: signal.id,
      projectId: signal.projectId,
      detectorId: signal.detectorId,
      title: signal.title,
      status: signal.status as SignalStatus,
      resolvedAt: signal.resolvedAt ? signal.resolvedAt.toISOString() : null,
      reopenCount: signal.reopenSeq,
    },
  };
}
