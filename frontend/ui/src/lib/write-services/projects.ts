import { prisma, Role, hasMinRole } from "@traceroot/core";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { writeAudit } from "./audit";
import type { Provenance, ServiceResult } from "./types";

export interface ProjectCreated {
  id: string;
  name: string;
  workspaceId: string;
}

export async function createProject(input: {
  actorUserId: string;
  workspaceId: string;
  name: string;
  traceTtlDays?: number | null;
  provenance: Provenance;
}): Promise<ServiceResult<ProjectCreated>> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) {
    return {
      ok: false,
      status: 400,
      error: "name must be a non-empty string (max 100 chars)",
    };
  }
  const traceTtlDays = input.traceTtlDays ?? null;
  if (
    traceTtlDays !== null &&
    (!Number.isInteger(traceTtlDays) || traceTtlDays < 1 || traceTtlDays > 365)
  ) {
    return {
      ok: false,
      status: 400,
      error: "traceTtlDays must be an integer between 1 and 365",
    };
  }
  // The idempotent match doubles as the P2002 re-read: it is exactly the
  // predicate of the partial unique index uq_project_workspace_live_name.
  const liveNameMatch = {
    where: { workspaceId: input.workspaceId, name, deleteTime: null },
    select: { id: true, name: true, workspaceId: true },
  };
  let result: ServiceResult<ProjectCreated>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.actorUserId,
          },
        },
        select: { role: true },
      });
      if (!member) {
        return {
          ok: false as const,
          status: 403 as const,
          error: "Not a member of this workspace",
        };
      }
      if (!hasMinRole(member.role, Role.MEMBER)) {
        return {
          ok: false as const,
          status: 403 as const,
          error: "Requires MEMBER role or higher",
        };
      }

      // Idempotent create: a live project with the same name in this workspace
      // is returned as-is, so agent/CLI retries can't fan out duplicates. This
      // findFirst is the fast path; the unique index is the backstop that
      // makes the idempotency atomic under concurrency.
      const existing = await tx.project.findFirst(liveNameMatch);
      if (existing) {
        return { ok: true as const, created: false, data: existing };
      }

      const project = await tx.project.create({
        data: {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          name,
          traceTtlDays,
        },
      });
      return {
        ok: true as const,
        created: true,
        data: {
          id: project.id,
          name: project.name,
          workspaceId: project.workspaceId,
        },
      };
    });
  } catch (e) {
    if (!isPrismaKnownError(e, "P2002")) throw e;
    // A concurrent identical create won the race on the unique index.
    // Postgres aborts the losing transaction, so re-read after rollback and
    // answer idempotently, exactly as the fast path would have.
    const raced = await prisma.project.findFirst(liveNameMatch);
    if (!raced) throw e;
    result = { ok: true, created: false, data: raced };
  }

  if (result.ok && result.created) {
    await writeAudit(prisma, {
      actorUserId: input.actorUserId,
      operation: "create_project",
      resourceType: "project",
      resourceId: result.data.id,
      workspaceId: input.workspaceId,
      projectId: result.data.id,
      summary: { name },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    });
  }
  return result;
}
