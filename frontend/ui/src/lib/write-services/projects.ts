/**
 * Project writes for every surface: the public API proxy, the agent binding
 * and the web app's cookie routes all land here.
 *
 * `updateProject` is PATCH semantics: a field the caller leaves out is
 * untouched, an explicit null clears the nullable ones (the retention
 * returns to the plan default, the RCA model settings to the worker's
 * default). It reads the row, diffs the patch against it and writes only
 * when something differs. A future `replaceProject` (PUT) would validate a
 * full body with the create schema and call the same diff-and-write core;
 * the core is shared on purpose.
 */
import type { DetectorAlertConfig, Project } from "@prisma/client";
import {
  DEFAULT_ALERT_WINDOW,
  isAlertWindow,
  isDecisionAdapter,
  isDecisionModelId,
  ModelSource,
  prisma,
  Role,
  hasMinRole,
} from "@traceroot/core";
import { z } from "zod";
import { isPrismaKnownError, prismaErrorTarget } from "@/lib/eval/prisma-errors";
import { seedDefaultDashboard } from "@/lib/dashboard-seed";
import { writeAudit } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

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
  // predicate of the partial unique index on the live name.
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
      // Only a genuinely new project seeds — the idempotent hit above returned
      // already, so a retried create can't touch an existing Default dashboard.
      await seedDefaultDashboard(tx, {
        projectId: project.id,
        actorUserId: input.actorUserId,
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
      summary: { name, defaultDashboard: true },
      transport: input.provenance.transport,
      agentSessionId: input.provenance.agentSessionId ?? null,
    });
  }
  return result;
}

/** The project as the update answers it: the row plus its alert settings. */
export interface ProjectRecord {
  id: string;
  name: string;
  workspaceId: string;
  traceTtlDays: number | null;
  rcaModel: string | null;
  rcaProvider: string | null;
  rcaSource: string | null;
  alertEmails: string[];
  alertWindow: string;
  createTime: Date;
  updateTime: Date;
}

/** The fields a project patch may carry; validated by `patchSchema` at the call. */
export interface ProjectPatch {
  name?: string;
  traceTtlDays?: number | null;
  rcaModel?: string | null;
  rcaProvider?: string | null;
  rcaSource?: string | null;
  alertEmails?: string[];
  alertWindow?: string;
}

const nameMessage = "name must be a non-empty string (max 100 chars)";
const ttlMessage = "traceTtlDays must be an integer between 1 and 365";
const alertEmailsMessage = "alertEmails must be a list of email addresses (max 50)";
const decisionRcaModelMessage = "rcaModel cannot be a decision model, which only runs detectors";
const decisionRcaProviderMessage =
  "rcaProvider cannot be a decision-model provider (TypeSafe), which only runs detectors";

const boundedText = (field: string, max: number) => {
  const message = `${field} must be a non-empty string (max ${max} chars)`;
  return z.string(message).min(1, message).max(max, message);
};

// The create's messages for the two public fields; the RCA model settings and
// the alert delivery settings are the web app's (they are not on the public
// create and the agent has no business changing where alerts are emailed),
// but the cookie route delegates here, so their validators live beside the
// others. Nullable fields take null to clear.
const patchSchema = z.object({
  name: z
    .string(nameMessage)
    .refine((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 && trimmed.length <= 100;
    }, nameMessage)
    .optional(),
  traceTtlDays: z
    .number(ttlMessage)
    .int(ttlMessage)
    .min(1, ttlMessage)
    .max(365, ttlMessage)
    .nullable()
    .optional(),
  rcaModel: boundedText("rcaModel", 200).nullable().optional(),
  rcaProvider: boundedText("rcaProvider", 200).nullable().optional(),
  rcaSource: boundedText("rcaSource", 200).nullable().optional(),
  alertEmails: z
    .array(
      z.string(alertEmailsMessage).email(alertEmailsMessage).max(254, alertEmailsMessage),
      alertEmailsMessage,
    )
    .max(50, alertEmailsMessage)
    .optional(),
  alertWindow: z
    .string("Invalid alert window")
    .refine(isAlertWindow, "Invalid alert window")
    .optional(),
});

type ProjectRow = Project & { alertConfig: DetectorAlertConfig | null };

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
    traceTtlDays: row.traceTtlDays,
    rcaModel: row.rcaModel,
    rcaProvider: row.rcaProvider,
    rcaSource: row.rcaSource,
    alertEmails: row.alertConfig?.emailAddresses ?? [],
    alertWindow: row.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

const PROJECT_NOT_FOUND = { ok: false, status: 404, error: "Project not found" } as const;
// The partial unique index over (workspaceId, name) where deleteTime is null.
// Raw SQL in the migration rather than a schema-level unique, so Prisma
// reports a collision on it by this name rather than by field list.
const LIVE_NAME_INDEX = "uq_project_workspace_live_name";

const PROJECT_NAME_TAKEN = {
  ok: false,
  status: 409,
  error: "A project with this name already exists",
} as const;

// The two administrative writes: ADMIN in the project's workspace, the row
// loaded with its alert settings, and the cookie route's workspace scope
// honored when it is named.
const adminAccess = (workspaceId: string | undefined) => ({
  minRole: Role.ADMIN,
  workspaceId,
  include: { alertConfig: true } as const,
});

/**
 * Partially update a project for an ADMIN of its workspace. Renaming a
 * project or changing its retention is an administrative act, which is why
 * the floor is above the create's.
 */
export async function updateProject(input: {
  actorUserId: string;
  projectId: string;
  /** When given, the project must belong to this workspace (the cookie route's path). */
  workspaceId?: string;
  patch: ProjectPatch;
  provenance: Provenance;
}): Promise<UpdateResult<ProjectRecord>> {
  let outcome: Awaited<EditOutcome<UpdateResult<ProjectRecord>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<ProjectRecord>> => {
      const access = await requireProjectMember(
        tx,
        input.projectId,
        input.actorUserId,
        adminAccess(input.workspaceId),
      );
      if (!access.ok) return { result: access };
      const existing = access.project;

      const parsed = patchSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const patch = { ...parsed.data, name: parsed.data.name?.trim() };
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }
      // A decision model (Jev) only judges detectors and the RCA resolver
      // rejects it, so refuse it when the setting is saved, not when RCA runs.
      if (patch.rcaModel && isDecisionModelId(patch.rcaModel)) {
        return { result: { ok: false, status: 400, error: decisionRcaModelMessage } };
      }
      // RCA reads rcaProvider as a BYOK row only when the source is BYOK; a
      // system source names a system provider, which is never a decision one.
      const rcaSource = patch.rcaSource !== undefined ? patch.rcaSource : existing.rcaSource;
      const rcaProvider =
        patch.rcaProvider !== undefined ? patch.rcaProvider : existing.rcaProvider;
      if (rcaProvider && rcaSource === ModelSource.BYOK) {
        const provider = await tx.modelProvider.findUnique({
          where: {
            workspaceId_provider: {
              workspaceId: existing.workspaceId,
              provider: rcaProvider,
            },
          },
          select: { adapter: true },
        });
        if (isDecisionAdapter(provider?.adapter)) {
          return { result: { ok: false, status: 400, error: decisionRcaProviderMessage } };
        }
      }

      const current = toProjectRecord(existing);
      const { changed, data } = diffPatch(patch, current);
      if (changed.length === 0) return { result: { ok: true, data: current, changed } };

      const { alertEmails, alertWindow, ...columns } = data;
      const alertSettings = {
        ...(alertEmails !== undefined && { emailAddresses: alertEmails }),
        ...(alertWindow !== undefined && { alertWindow }),
      };
      const project = await tx.project.update({
        // Scoped to a live row: a project soft-deleted after the read misses
        // here (P2025, mapped to the 404 below) instead of being mutated and
        // audited as if it were still live.
        where: { id: existing.id, deleteTime: null },
        data: {
          ...columns,
          ...(Object.keys(alertSettings).length > 0 && {
            alertConfig: { upsert: { create: alertSettings, update: alertSettings } },
          }),
          updateTime: new Date(),
        },
        include: { alertConfig: true },
      });
      return {
        result: { ok: true, data: toProjectRecord(project), changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_project",
          resourceType: "project",
          resourceId: existing.id,
          workspaceId: existing.workspaceId,
          projectId: existing.id,
          summary: { changed },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    // Deleted or soft-deleted concurrently between the scoped read and the write.
    if (isPrismaKnownError(e, "P2025")) return PROJECT_NOT_FOUND;
    // Only a rename can hit the live-name index. The alertConfig upsert can
    // raise its own P2002 (racing a concurrent first insert on its project-id
    // key) even when this patch carries a name, so match the violated
    // constraint exactly; any other target, or none, is not the rename and
    // is rethrown rather than reported as a name collision.
    if (isPrismaKnownError(e, "P2002") && prismaErrorTarget(e) === LIVE_NAME_INDEX) {
      return PROJECT_NAME_TAKEN;
    }
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Soft-delete a project for an ADMIN of its workspace: the row keeps its
 * data for the retention window, drops out of every list and read, and its
 * access keys stop authenticating. The statement is scoped to a live row, so
 * a second delete of the same id is a 404 rather than a re-stamp.
 */
export async function deleteProject(input: {
  actorUserId: string;
  projectId: string;
  /** When given, the project must belong to this workspace (the cookie route's path). */
  workspaceId?: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  const outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
    const access = await requireProjectMember(
      tx,
      input.projectId,
      input.actorUserId,
      adminAccess(input.workspaceId),
    );
    if (!access.ok) return { result: access };
    const existing = access.project;

    const now = new Date();
    const { count } = await tx.project.updateMany({
      where: { id: existing.id, deleteTime: null },
      data: { deleteTime: now, updateTime: now },
    });
    if (count === 0) return { result: PROJECT_NOT_FOUND };
    return {
      result: { ok: true, data: { id: existing.id, name: existing.name }, reason: reason.reason },
      audit: {
        actorUserId: input.actorUserId,
        operation: "delete_project",
        resourceType: "project",
        resourceId: existing.id,
        workspaceId: existing.workspaceId,
        projectId: existing.id,
        summary: { name: existing.name, reason: reason.reason },
        transport: input.provenance.transport,
        agentSessionId: input.provenance.agentSessionId ?? null,
      },
    };
  });
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
