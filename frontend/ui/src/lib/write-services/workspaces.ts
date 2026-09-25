/**
 * Workspace writes for every surface: the public API proxy, the agent
 * binding and the web app's cookie routes all land here.
 *
 * `updateWorkspace` is PATCH semantics: a field the caller leaves out is
 * untouched. It reads the row, diffs the patch against it and writes only
 * when something differs. A future `replaceWorkspace` (PUT) would validate a
 * full body with the create schema and call the same diff-and-write core;
 * the core is shared on purpose.
 */
import type { Prisma } from "@prisma/client";
import { prisma, Role, hasMinRole } from "@traceroot/core";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { writeAudit } from "./audit";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, diffPatch, validateDeleteReason } from "./update-support";

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

/** The workspace as the update answers it. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  /** The caller's role, always ADMIN: the gate below admits no one else. */
  role: "ADMIN";
  createTime: Date;
  updateTime: Date;
}

const NAME_MESSAGE = "name must be a non-empty string (max 100 chars)";
const WORKSPACE_NOT_FOUND = { ok: false, status: 404, error: "Workspace not found" } as const;
const WORKSPACE_NAME_TAKEN = {
  ok: false,
  status: 409,
  error: "A workspace with this name already exists",
} as const;

/**
 * The ADMIN gate for the two administrative writes. Workspace membership is
 * the tenancy here, so a non-member is a 403 rather than a 404, as on the
 * project create and the cookie routes.
 */
async function requireWorkspaceAdmin(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actorUserId: string,
): Promise<{ ok: true; role: "ADMIN" } | { ok: false; status: 403; error: string }> {
  const member = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    select: { role: true },
  });
  if (!member) return { ok: false, status: 403, error: "Not a member of this workspace" };
  if (!hasMinRole(member.role, Role.ADMIN)) {
    return { ok: false, status: 403, error: "Requires ADMIN role or higher" };
  }
  return { ok: true, role: "ADMIN" };
}

function toWorkspaceRecord(row: {
  id: string;
  name: string;
  createTime: Date;
  updateTime: Date;
}): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    role: "ADMIN",
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

/**
 * Rename a workspace for one of its ADMINs. Renaming is an administrative
 * act, which is why the floor is above the create's. A name the creator
 * already uses for another workspace is a 409, including one that appears
 * between the read and the write.
 */
export async function updateWorkspace(input: {
  actorUserId: string;
  workspaceId: string;
  patch: { name?: string };
  provenance: Provenance;
}): Promise<UpdateResult<WorkspaceRecord>> {
  let outcome: Awaited<EditOutcome<UpdateResult<WorkspaceRecord>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<WorkspaceRecord>> => {
      const access = await requireWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);
      if (!access.ok) return { result: access };

      const rawName = input.patch?.name;
      if (rawName === undefined)
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name || name.length > 100)
        return { result: { ok: false, status: 400, error: NAME_MESSAGE } };

      const existing = await tx.workspace.findUnique({ where: { id: input.workspaceId } });
      if (!existing) return { result: WORKSPACE_NOT_FOUND };

      const { changed, data } = diffPatch({ name }, existing);
      if (changed.length === 0) {
        return { result: { ok: true, data: toWorkspaceRecord(existing), changed } };
      }
      const workspace = await tx.workspace.update({
        where: { id: existing.id },
        data: { ...data, updateTime: new Date() },
      });
      return {
        result: { ok: true, data: toWorkspaceRecord(workspace), changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_workspace",
          resourceType: "workspace",
          resourceId: existing.id,
          workspaceId: existing.id,
          summary: { changed },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    // Deleted concurrently between the read and the write.
    if (isPrismaKnownError(e, "P2025")) return WORKSPACE_NOT_FOUND;
    // The creator already has another workspace by this name
    // (uq_workspace_created_by_name).
    if (isPrismaKnownError(e, "P2002")) return WORKSPACE_NAME_TAKEN;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Hard-delete a workspace for one of its ADMINs, relying on the schema's
 * cascades for its projects, access keys, memberships and invites. `name`
 * must equal the workspace's current name: a typed confirmation the server
 * enforces, not just the client. The caller's only workspace is refused,
 * counted under a lock on their user row so concurrent deletes cannot each
 * pass the guard.
 */
export async function deleteWorkspace(input: {
  actorUserId: string;
  workspaceId: string;
  name: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  let outcome: Awaited<EditOutcome<DeleteResult>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
      const access = await requireWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);
      if (!access.ok) return { result: access };

      const existing = await tx.workspace.findUnique({ where: { id: input.workspaceId } });
      if (!existing) return { result: WORKSPACE_NOT_FOUND };
      if (input.name !== existing.name) {
        return { result: { ok: false, status: 409, error: "Workspace name does not match" } };
      }
      // The count below is only a guard if nothing else deletes meanwhile:
      // two concurrent deletes of the caller's last two workspaces would each
      // count two and both cascade. Locking the caller's user row serializes
      // them, so the second counts what the first left. Raw because Prisma
      // has no row-lock API; the table name is the mapped one from the schema.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${input.actorUserId} FOR UPDATE`;
      const memberships = await tx.workspaceMember.count({ where: { userId: input.actorUserId } });
      if (memberships <= 1) {
        return { result: { ok: false, status: 409, error: "Cannot delete your only workspace" } };
      }

      const cascaded = {
        projects: await tx.project.count({ where: { workspaceId: existing.id, deleteTime: null } }),
      };
      await tx.workspace.delete({ where: { id: existing.id } });
      return {
        result: {
          ok: true,
          data: { id: existing.id, name: existing.name },
          reason: reason.reason,
          cascaded,
        },
        audit: {
          actorUserId: input.actorUserId,
          operation: "delete_workspace",
          resourceType: "workspace",
          resourceId: existing.id,
          workspaceId: existing.id,
          summary: { name: existing.name, reason: reason.reason, cascaded },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return WORKSPACE_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
