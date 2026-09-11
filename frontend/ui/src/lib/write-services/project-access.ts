import { Role, hasMinRole } from "@traceroot/core";
import type { Prisma } from "@prisma/client";

export type ProjectAccess =
  | { ok: true; workspaceId: string }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Shared by the project-scoped writes: the target project must exist (and not
 * be soft-deleted) and the actor must hold at least MEMBER in its workspace.
 */
export async function requireProjectMember(
  tx: Prisma.TransactionClient,
  projectId: string,
  actorUserId: string,
): Promise<ProjectAccess> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deleteTime: true },
  });
  if (!project || project.deleteTime !== null) {
    return { ok: false, status: 404, error: "Project not found" };
  }
  const member = await tx.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: project.workspaceId,
        userId: actorUserId,
      },
    },
    select: { role: true },
  });
  if (!member) {
    // Same status and message as a missing project: a 403 here would tell a
    // signed-in outsider that the project id exists in someone else's
    // workspace, which the read paths deliberately never reveal.
    return { ok: false, status: 404, error: "Project not found" };
  }
  if (!hasMinRole(member.role, Role.MEMBER)) {
    return { ok: false, status: 403, error: "Requires MEMBER role or higher" };
  }
  return { ok: true, workspaceId: project.workspaceId };
}
