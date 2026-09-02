import { prisma, Role } from "@traceroot/core";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
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
  // The idempotent match: a live workspace by this name that the actor
  // already administers.
  const adminMatch = {
    name,
    members: { some: { userId: input.actorUserId, role: Role.ADMIN } },
  };
  let result: ServiceResult<WorkspaceCreated>;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Idempotent create: same actor + same name returns the workspace they
      // already administer, so agent/CLI retries can't fan out duplicates.
      // This findFirst is the fast path; uq_workspace_created_by_name is the
      // backstop that makes the idempotency atomic under concurrency.
      const existing = await tx.workspace.findFirst({
        where: adminMatch,
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
        data: { id: crypto.randomUUID(), name, createdBy: input.actorUserId },
      });
      await tx.workspaceMember.create({
        data: {
          id: crypto.randomUUID(),
          workspaceId: ws.id,
          userId: input.actorUserId,
          role: Role.ADMIN,
        },
      });
      return {
        ok: true as const,
        created: true,
        data: { id: ws.id, name: ws.name, role: "ADMIN" as const },
      };
    });
  } catch (e) {
    if (!isPrismaKnownError(e, "P2002")) throw e;
    // A concurrent identical create won the race on (created_by, name).
    // Postgres aborts the losing transaction, so re-read after rollback and
    // answer idempotently, exactly as the fast path would have.
    const raced = await prisma.workspace.findFirst({
      where: adminMatch,
      select: { id: true, name: true },
    });
    if (!raced) {
      // The name is held by a workspace the actor created but no longer
      // administers — not addressable as an idempotent hit.
      return {
        ok: false,
        status: 409,
        error: "A workspace with this name already exists",
      };
    }
    return {
      ok: true,
      created: false,
      data: { id: raced.id, name: raced.name, role: "ADMIN" },
    };
  }

  if (result.ok && result.created) {
    await writeAudit(prisma, {
      actorUserId: input.actorUserId,
      operation: "create_workspace",
      resourceType: "workspace",
      resourceId: result.data.id,
      workspaceId: result.data.id,
      summary: { name },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    });
  }
  return result;
}
