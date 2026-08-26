import { prisma, Role } from "@traceroot/core";
import { writeAudit } from "./audit";
import type { Provenance, ServiceResult } from "./types";

export interface WorkspaceCreated {
  id: string;
  name: string;
  role: "ADMIN";
}

export async function createWorkspace(input: {
  actorUserId: string;
  name: string;
  provenance: Provenance;
}): Promise<ServiceResult<WorkspaceCreated>> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) {
    return {
      ok: false,
      status: 400,
      error: "name must be a non-empty string (max 100 chars)",
    };
  }
  return prisma.$transaction(async (tx) => {
    // Idempotent create: same actor + same name returns the workspace they
    // already administer, so agent/CLI retries can't fan out duplicates.
    const existing = await tx.workspace.findFirst({
      where: {
        name,
        members: { some: { userId: input.actorUserId, role: Role.ADMIN } },
      },
      select: { id: true, name: true },
    });
    if (existing) {
      return {
        ok: true as const,
        created: false,
        data: { id: existing.id, name: existing.name, role: "ADMIN" as const },
      };
    }

    const ws = await tx.workspace.create({
      data: { id: crypto.randomUUID(), name },
    });
    await tx.workspaceMember.create({
      data: {
        id: crypto.randomUUID(),
        workspaceId: ws.id,
        userId: input.actorUserId,
        role: Role.ADMIN,
      },
    });
    await writeAudit(tx, {
      actorUserId: input.actorUserId,
      operation: "create_workspace",
      resourceType: "workspace",
      resourceId: ws.id,
      workspaceId: ws.id,
      summary: { name },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    });
    return {
      ok: true as const,
      created: true,
      data: { id: ws.id, name: ws.name, role: "ADMIN" as const },
    };
  });
}
