/**
 * Loop writes for the web app's cookie routes: create, patch, pause / resume,
 * delete, and "Run now". A Loop is created with its hidden detector, which
 * outlives it; "Run now" inserts a pending run that the worker's next tick picks
 * up (the web app cannot reach the queue, the same constraint RCA has).
 *
 * `updateLoop` is PATCH semantics like `updateDetector`: a field left out is
 * untouched, and nothing is written (or audited) when nothing differs.
 */
import { prisma, detectorModelProblem, listWorkspaceModels } from "@traceroot/core";
import {
  LOOP_LIMITS,
  LOOP_NAME_TAKEN,
  LOOP_NAME_TAKEN_BY_DETECTOR,
  LOOP_RUN_IN_PROGRESS,
  LOOP_RUN_PAUSED,
  LOOP_RUN_PLAN_BLOCKED,
  createLoopSchema,
  createLoopWithDetector,
  createRun,
  deleteLoopKeepingDetector,
  getLoopTemplate,
  hasActiveRun,
  lockLoop,
  loopToDto,
  nextRunAt,
  projectAtLoopCap,
  renameLoopDetector,
  runToDto,
  scheduleFromColumns,
  scheduleToColumns,
  updateLoopSchema,
  type LoopDto,
  type LoopRunDto,
} from "@traceroot/core/loops";
import { isNameCollision, isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { writeAudit } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

const LOOP_NOT_FOUND = { ok: false, status: 404, error: "Loop not found" } as const;

/**
 * The answer to a name collision on `name`: the Loop's (projectId, name) index or
 * its hidden detector's ("loop:<name>"), which the error cannot tell apart. Read
 * after the rollback: a Loop has the name, or an existing user detector has
 * the hidden detector's name.
 */
async function nameTakenResult(projectId: string, name: string) {
  const loop = await prisma.loop.findFirst({ where: { projectId, name }, select: { id: true } });
  return {
    ok: false,
    status: 409,
    error: loop ? LOOP_NAME_TAKEN : LOOP_NAME_TAKEN_BY_DETECTOR,
  } as const;
}

/** The model fields as the detector check reads them. */
const modelChoice = (v: {
  source?: "system" | "byok" | null;
  model?: string | null;
  provider?: string | null;
}) => ({
  detectionSource: v.source ?? null,
  detectionModel: v.model ?? null,
  detectionProvider: v.provider ?? null,
});

/** Create a Loop from a request body, validated here against createLoopSchema. */
export async function createLoop(input: {
  body: unknown;
  actorUserId: string;
  projectId: string;
  provenance: Provenance;
}): Promise<ServiceResult<LoopDto>> {
  let outcome: Awaited<EditOutcome<ServiceResult<LoopDto>>>;
  // The validated (trimmed) name, for a name collision raised by the create.
  let name = "";
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<ServiceResult<LoopDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = createLoopSchema.safeParse(input.body);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const v = parsed.data;
      name = v.name;

      if (v.model || v.source === "byok") {
        const problem = detectorModelProblem(
          modelChoice(v),
          await listWorkspaceModels(access.workspaceId, { db: tx }),
        );
        if (problem !== null) return { result: { ok: false, status: 400, error: problem } };
      }

      if (await projectAtLoopCap(tx, input.projectId)) {
        return {
          result: {
            ok: false,
            status: 409,
            error: `A project can have at most ${LOOP_LIMITS.loopsPerProject} loops`,
          },
        };
      }

      const template = getLoopTemplate(v.template);
      const loop = await createLoopWithDetector(tx, {
        projectId: input.projectId,
        createdBy: input.actorUserId,
        name: v.name,
        template: template?.id ?? null,
        instructions: v.instructions,
        schedule: v.schedule,
        dryRun: v.dryRun ?? false,
        lookbackHours: v.lookbackHours ?? template?.lookbackHours ?? 24,
        model: v.model || null,
        provider: v.provider || null,
        source: v.source ?? null,
        now: new Date(),
      });
      return {
        result: { ok: true, created: true, data: loopToDto(loop) },
        audit: {
          actorUserId: input.actorUserId,
          operation: "create_loop",
          resourceType: "loop",
          resourceId: loop.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: {
            name: v.name,
            template: loop.template,
            schedule: v.schedule,
            dryRun: loop.dryRun,
          },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isNameCollision(e)) return nameTakenResult(input.projectId, name);
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

export async function updateLoop(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  /** A request body, validated here against updateLoopSchema. */
  patch: unknown;
  provenance: Provenance;
}): Promise<UpdateResult<LoopDto>> {
  let outcome: Awaited<EditOutcome<UpdateResult<LoopDto>>>;
  // The validated (trimmed) new name, for a name collision raised by a rename.
  let newName: string | undefined;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<LoopDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = updateLoopSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const patch = parsed.data;
      newName = patch.name;
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }

      const existing = await tx.loop.findFirst({
        where: { id: input.loopId, projectId: input.projectId },
      });
      if (!existing) return { result: LOOP_NOT_FOUND };

      // Any one model field changes the choice, so the merged result is checked.
      if (patch.model !== undefined || patch.provider !== undefined || patch.source !== undefined) {
        const problem = detectorModelProblem(
          modelChoice({
            source:
              patch.source === undefined
                ? (existing.source as "system" | "byok" | null)
                : patch.source,
            model: patch.model === undefined ? existing.model : patch.model,
            provider: patch.provider === undefined ? existing.provider : patch.provider,
          }),
          await listWorkspaceModels(access.workspaceId, { db: tx }),
        );
        if (problem !== null) return { result: { ok: false, status: 400, error: problem } };
      }

      const current = loopToDto(existing);
      const { changed, data } = diffPatch(
        {
          ...patch,
          // Falsy reads as "unset" on the model fields, as on the detector write.
          model: patch.model === undefined ? undefined : patch.model || null,
          provider: patch.provider === undefined ? undefined : patch.provider || null,
        },
        current,
      );
      if (changed.length === 0) return { result: { ok: true, data: current, changed } };

      const { schedule, template, ...columns } = data;
      const now = new Date();
      const row = await tx.loop.update({
        where: { id: existing.id },
        data: {
          ...columns,
          ...(template === undefined ? {} : { template: template ?? null }),
          ...(schedule === undefined
            ? {}
            : { ...scheduleToColumns(schedule), nextRunAt: nextRunAt(schedule, now) }),
        },
      });
      if (columns.name !== undefined) await renameLoopDetector(tx, row, columns.name);
      return {
        result: { ok: true, data: loopToDto(row), changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_loop",
          resourceType: "loop",
          resourceId: existing.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { changed },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return LOOP_NOT_FOUND;
    // Only a rename can collide.
    if (isNameCollision(e) && newName !== undefined) {
      return nameTakenResult(input.projectId, newName);
    }
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Pause or resume. A person's pause is only ever undone by a person; resuming
 * clears the failure streak and counts the next run from now, so a Loop that
 * sat paused does not fire for the slots it missed.
 */
export async function setLoopStatus(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  action: "pause" | "resume";
  provenance: Provenance;
}): Promise<UpdateResult<LoopDto>> {
  let outcome: Awaited<EditOutcome<UpdateResult<LoopDto>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<LoopDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const existing = await tx.loop.findFirst({
        where: { id: input.loopId, projectId: input.projectId },
      });
      if (!existing) return { result: LOOP_NOT_FOUND };

      const target = input.action === "pause" ? "paused" : "active";
      if (existing.status === target) {
        return { result: { ok: true, data: loopToDto(existing), changed: [] } };
      }
      const now = new Date();
      const row = await tx.loop.update({
        where: { id: existing.id },
        data: {
          status: target,
          ...(target === "active"
            ? {
                failureStreak: 0,
                nextRunAt: nextRunAt(scheduleFromColumns(existing), now),
              }
            : {}),
        },
      });
      return {
        result: { ok: true, data: loopToDto(row), changed: ["status"] },
        audit: {
          actorUserId: input.actorUserId,
          operation: input.action === "pause" ? "pause_loop" : "resume_loop",
          resourceType: "loop",
          resourceId: existing.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { from: existing.status, to: target },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return LOOP_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/** Delete the Loop; its runs go with it, its hidden detector and signals stay. */
export async function deleteLoop(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  let outcome: Awaited<EditOutcome<DeleteResult>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const existing = await tx.loop.findFirst({
        where: { id: input.loopId, projectId: input.projectId },
      });
      if (!existing) return { result: LOOP_NOT_FOUND };

      await deleteLoopKeepingDetector(tx, existing);
      return {
        result: { ok: true, data: { id: existing.id, name: existing.name }, reason: reason.reason },
        audit: {
          actorUserId: input.actorUserId,
          operation: "delete_loop",
          resourceType: "loop",
          resourceId: existing.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { name: existing.name, reason: reason.reason },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return LOOP_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * "Run now": a pending manual run for the worker's next tick. One active run
 * per Loop, none while it is paused or its workspace's plan runs are used up
 * (the worker would only skip it).
 */
export async function requestLoopRun(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  provenance: Provenance;
}): Promise<ServiceResult<LoopRunDto>> {
  let outcome: Awaited<EditOutcome<ServiceResult<LoopRunDto>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<ServiceResult<LoopRunDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId, {
        include: { workspace: { select: { loopBlocked: true } } },
      });
      if (!access.ok) return { result: access };

      const loop = await lockLoop(tx, input.projectId, input.loopId);
      if (!loop) return { result: LOOP_NOT_FOUND };
      if (loop.status !== "active") {
        return { result: { ok: false, status: 409, error: LOOP_RUN_PAUSED } };
      }
      if (access.project.workspace.loopBlocked) {
        return { result: { ok: false, status: 409, error: LOOP_RUN_PLAN_BLOCKED } };
      }
      if (await hasActiveRun(tx, loop.id)) {
        return { result: { ok: false, status: 409, error: LOOP_RUN_IN_PROGRESS } };
      }
      const run = await createRun(tx, {
        loopId: loop.id,
        projectId: input.projectId,
        trigger: "manual",
      });
      return {
        result: { ok: true, created: true, data: runToDto(run) },
        audit: {
          actorUserId: input.actorUserId,
          operation: "run_loop",
          resourceType: "loop",
          resourceId: loop.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { name: loop.name, runId: run.id, seq: run.seq },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return LOOP_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
