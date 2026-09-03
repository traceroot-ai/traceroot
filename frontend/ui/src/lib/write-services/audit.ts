import type { Prisma, PrismaClient } from "@prisma/client";

/** The subset of the client the writer needs. */
export type PrismaTxLike = Pick<PrismaClient, "auditLog">;

export interface AuditEntry {
  actorUserId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  summary: Record<string, unknown>;
  transport: "public-api" | "agent";
  agentSessionId?: string | null;
}

// Best-effort by design: losing an audit row is better than failing the
// user's write after the resource already exists. Call this only with the root
// client once the resource transaction has committed — inside a transaction a
// failed INSERT aborts the whole transaction, so catching the error here would
// still discard the resource the caller was told it created.
export async function writeAudit(db: PrismaTxLike, entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        operation: entry.operation,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        workspaceId: entry.workspaceId ?? null,
        projectId: entry.projectId ?? null,
        summary: entry.summary as Prisma.InputJsonValue,
        transport: entry.transport,
        agentSessionId: entry.agentSessionId ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] failed to record write:", err);
  }
}
