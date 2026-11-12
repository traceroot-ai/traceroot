/**
 * Loop writes for the web app's cookie routes: create, patch, pause / resume,
 * delete, and "Run now". A Loop and its hidden detector are created and deleted
 * together; "Run now" inserts a pending run that the worker's next tick picks
 * up (the web app cannot reach the queue, the same constraint RCA has).
 *
 * `updateLoop` is PATCH semantics like `updateDetector`: a field left out is
 * untouched, and nothing is written (or audited) when nothing differs.
 */
import { prisma, detectorModelProblem, listWorkspaceModels } from "@traceroot/core";
import {
  LOOP_LIMITS,
  createLoopSchema,
  createLoopWithDetector,
  createRun,
  deleteLoopWithDetector,
  getLoopTemplate,
  hasActiveRun,
  loopToDto,
  nextRunAt,
  renameLoopDetector,
  runToDto,
  scheduleFromColumns,
  scheduleToColumns,
  statusChange,
  updateLoopSchema,
  type CreateLoopInput,
  type LoopDto,
  type LoopRunDto,
  type UpdateLoopInput,
} from "@traceroot/core/loops";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { writeAudit } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

const LOOP_NOT_FOUND = { ok: false, status: 404, error: "Loop not found" } as const;
const LOOP_NAME_TAKEN = {
  ok: false,
  status: 409,
  error: "A Loop with this name already exists",
} as const;

const isNameCollision = (e: unknown) => isPrismaKnownError(e, "P2002");

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

export async function createLoop(
  input: CreateLoopInput & { actorUserId: string; projectId: string; provenance: Provenance },
): Promise<ServiceResult<LoopDto>> {
  let outcome: Awaited<EditOutcome<ServiceResult<LoopDto>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<ServiceResult<LoopDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = createLoopSchema.safeParse(input);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const v = parsed.data;

      if (v.model || v.source === "byok") {
        const problem = detectorModelProblem(
          modelChoice(v),
          await listWorkspaceModels(access.workspaceId, { db: tx }),
        );
        if (problem !== null) return { result: { ok: false, status: 400, error: problem } };
      }

      const existing = await tx.loop.count({ where: { projectId: input.projectId } });
      if (existing >= LOOP_LIMITS.loopsPerProject) {
        return {
          result: {
            ok: false,
            status: 409,
            error: `A project can have at most ${LOOP_LIMITS.loopsPerProject} Loops`,
          },
        };
      }

      const template = getLoopTemplate(v.template);
      const loop = await createLoopWithDetector(tx, {
        projectId: input.projectId,
        createdBy: input.actorUserId,
        name: v.name,
        template: template?.id ?? null,
        templateVersion: template?.version ?? null,
        instructions: v.instructions ?? "",
        schedule: v.schedule,
        dryRun: v.dryRun ?? false,
        precheckSql: v.precheckSql || null,
        lookbackHours: v.lookbackHours ?? template?.lookbackHours ?? 24,
        maxFindingsPerRun: v.maxFindingsPerRun ?? LOOP_LIMITS.newFindingKeysPerRun,
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
    if (isNameCollision(e)) return LOOP_NAME_TAKEN;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

export async function updateLoop(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  patch: UpdateLoopInput;
  provenance: Provenance;
}): Promise<UpdateResult<LoopDto>> {
  let outcome: Awaited<EditOutcome<UpdateResult<LoopDto>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<LoopDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = updateLoopSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const patch = parsed.data;
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }

      const existing = await tx.loop.findFirst({
        where: { id: input.loopId, projectId: input.projectId },
      });
      if (!existing) return { result: LOOP_NOT_FOUND };

      if (patch.model || patch.source === "byok") {
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

      // Dropping the template leaves the Loop with only its own instructions.
      const instructionsAfter = patch.instructions ?? existing.instructions;
      if (patch.template === null && instructionsAfter.trim().length === 0) {
        return {
          result: {
            ok: false,
            status: 400,
            error: "instructions are required unless a template is chosen",
          },
        };
      }

      const current = loopToDto(existing);
      const { changed, data } = diffPatch(
        {
          ...patch,
          // Falsy reads as "unset" on the model fields, as on the detector write.
          model: patch.model === undefined ? undefined : patch.model || null,
          provider: patch.provider === undefined ? undefined : patch.provider || null,
          precheckSql: patch.precheckSql === undefined ? undefined : patch.precheckSql || null,
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
          ...(template === undefined
            ? {}
            : {
                template: template ?? null,
                templateVersion: getLoopTemplate(template)?.version ?? null,
              }),
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
    if (isNameCollision(e)) return LOOP_NAME_TAKEN;
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
          ...statusChange(target, input.actorUserId, now),
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

/** Delete the Loop and its hidden detector. Its runs and memory go with it; its signals stay. */
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

      await deleteLoopWithDetector(tx, existing);
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

/** "Run now": a pending manual run for the worker's next tick. One active run per Loop. */
export async function requestLoopRun(input: {
  actorUserId: string;
  projectId: string;
  loopId: string;
  provenance: Provenance;
}): Promise<ServiceResult<LoopRunDto>> {
  let outcome: Awaited<EditOutcome<ServiceResult<LoopRunDto>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<ServiceResult<LoopRunDto>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const loop = await tx.loop.findFirst({
        where: { id: input.loopId, projectId: input.projectId },
        select: { id: true, name: true },
      });
      if (!loop) return { result: LOOP_NOT_FOUND };

      // The run insert locks the Loop row, but the check must come first and
      // see the same state, so take the lock before looking.
      await tx.$queryRaw`SELECT id FROM loops WHERE id = ${loop.id} FOR UPDATE`;
      if (await hasActiveRun(tx, loop.id)) {
        return {
          result: { ok: false, status: 409, error: "This Loop already has a run in progress" },
        };
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
