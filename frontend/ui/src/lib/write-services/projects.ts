import { prisma, Role, hasMinRole } from "@traceroot/core";
import { seedDefaultDashboard } from "@/lib/dashboard-seed";
import { writeAudit, type AuditEntry } from "./audit";
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
  let audit: AuditEntry | null = null;
  const result = await prisma.$transaction(async (tx) => {
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
    // is returned as-is, so agent/CLI retries can't fan out duplicates.
    const existing = await tx.project.findFirst({
      where: { workspaceId: input.workspaceId, name, deleteTime: null },
      select: { id: true, name: true, workspaceId: true },
    });
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
    // Only a genuinely new project seeds — the idempotent hit above returned
    // already, so a retried create can't touch an existing Default dashboard.
    await seedDefaultDashboard(tx, {
      projectId: project.id,
      actorUserId: input.actorUserId,
    });
    audit = {
      actorUserId: input.actorUserId,
      operation: "create_project",
      resourceType: "project",
      resourceId: project.id,
      workspaceId: input.workspaceId,
      projectId: project.id,
      summary: { name, defaultDashboard: true },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    };
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
  if (audit) await writeAudit(prisma, audit);
  return result;
}
