import type { Prisma, PrismaClient } from "@prisma/client";

/** The subset of the client the writer needs — a transaction client qualifies. */
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
// user's write after the resource already exists.
export async function writeAudit(tx: PrismaTxLike, entry: AuditEntry): Promise<void> {
  try {
    await tx.auditLog.create({
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
