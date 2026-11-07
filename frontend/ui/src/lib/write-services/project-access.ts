import { Role, hasMinRole } from "@traceroot/core";
import type { Prisma } from "@prisma/client";

export type ProjectAccess<P = { workspaceId: string }> =
  | { ok: true; workspaceId: string; project: P }
  | { ok: false; status: 403 | 404; error: string };

export interface ProjectAccessOptions<I extends Prisma.ProjectInclude | undefined> {
  /** The role floor; MEMBER unless the write is an administrative act. */
  minRole?: Role;
  /** When given, the project must belong to this workspace (the cookie routes' nested paths). */
  workspaceId?: string;
  /** Relations to load on the project row the access carries back. */
  include?: I;
}

type ProjectPayload<I extends Prisma.ProjectInclude | undefined> = I extends Prisma.ProjectInclude
  ? Prisma.ProjectGetPayload<{ include: I }>
  : { workspaceId: string };

/**
 * The one tenancy gate for the project-scoped writes: the target project must
 * exist (and not be soft-deleted, and sit in `workspaceId` when one is named)
 * and the actor must hold at least `minRole` in its workspace. A non-member
 * gets the same 404 as a missing project, so a signed-in outsider cannot
 * confirm that a project id exists in someone else's workspace, which the
 * read paths deliberately never reveal.
 */
export async function requireProjectMember<I extends Prisma.ProjectInclude | undefined = undefined>(
  tx: Prisma.TransactionClient,
  projectId: string,
  actorUserId: string,
  options: ProjectAccessOptions<I> = {},
): Promise<ProjectAccess<ProjectPayload<I>>> {
  const where = {
    id: projectId,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  };
  const project = (
    options.include
      ? await tx.project.findUnique({ where, include: options.include })
      : await tx.project.findUnique({ where, select: { workspaceId: true, deleteTime: true } })
  ) as (ProjectPayload<I> & { workspaceId: string; deleteTime: Date | null }) | null;
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
    // Same status and message as a missing project: see the doc comment.
    return { ok: false, status: 404, error: "Project not found" };
  }
  const minRole = options.minRole ?? Role.MEMBER;
  if (!hasMinRole(member.role, minRole)) {
    return { ok: false, status: 403, error: `Requires ${minRole} role or higher` };
  }
  return { ok: true, workspaceId: project.workspaceId, project };
}
