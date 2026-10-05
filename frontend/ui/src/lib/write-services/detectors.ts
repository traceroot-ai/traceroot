/**
 * Detector writes for every surface: the public API proxy, the agent binding
 * and the web app's cookie routes all land here.
 *
 * `updateDetector` is PATCH semantics: a field the caller leaves out is
 * untouched, an explicit null clears the detection fields, which are the
 * nullable ones. It reads the row, diffs the patch against it and writes only
 * when something differs. A future `replaceDetector` (PUT) would validate a
 * full body with the create schema and call the same diff-and-write core; the
 * core is shared on purpose.
 */
import type { Detector, DetectorTrigger } from "@prisma/client";
import {
  prisma,
  Role,
  hasMinRole,
  detectorModelProblem,
  listWorkspaceModels,
} from "@traceroot/core";
import { z } from "zod";
import { isPrismaKnownError, prismaErrorTarget } from "@/lib/eval/prisma-errors";
import {
  DEFAULT_DETECTOR_SAMPLE_RATE,
  DETECTOR_TEMPLATES,
  getTemplate,
} from "@/features/detectors/templates";
import { validateTriggerConditions } from "@/features/detectors/trigger-fields";
import { writeAudit, type AuditEntry } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

export interface DetectorCreated {
  id: string;
  name: string;
  projectId: string;
  enabled: boolean;
  sampleRate: number;
}

const nonEmptyString = (field: string) => {
  const message = `${field} must be a non-empty string`;
  return z.string(message).refine((value) => value.trim().length > 0, message);
};

const sampleRateMessage = "sampleRate must be an integer between 0 and 100";

const sampleRateSchema = z
  .number(sampleRateMessage)
  .int(sampleRateMessage)
  .min(0, sampleRateMessage)
  .max(100, sampleRateMessage);

// Validated against the trigger-field registry — an unknown field or
// operator would be stored fine but never match at evaluation time,
// silently disabling the detector.
const triggerConditionsSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined) return;
  const error = validateTriggerConditions(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
});

// Templates whose canonical instructions a caller may adopt by omitting
// prompt. Derived from the template data so the set cannot drift; blank is
// excluded because its prompt is empty.
const STANDARD_TEMPLATE_IDS = DETECTOR_TEMPLATES.filter((t) => t.id !== "blank").map((t) => t.id);

// Mirrors the cookie route's validation verbatim so both write surfaces
// reject the same payloads with the same messages — except prompt, which
// only this surface may omit to adopt a standard template's instructions.
// The model check below the schema is shared with that route the same way.
const inputSchema = z
  .object({
    name: nonEmptyString("name"),
    template: nonEmptyString("template"),
    prompt: nonEmptyString("prompt").optional(),
    sampleRate: sampleRateSchema.optional(),
    outputSchema: z.array(z.unknown(), "outputSchema must be an array").optional(),
    triggerConditions: triggerConditionsSchema,
    detectionSource: z
      .union(
        [z.literal("system"), z.literal("byok"), z.null()],
        'detectionSource must be "system" or "byok"',
      )
      .optional(),
    detectionModel: z.string().nullable().optional(),
    detectionProvider: z.string().nullable().optional(),
    enableRca: z.boolean("enableRca must be a boolean").optional(),
    enabled: z.boolean("enabled must be a boolean").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.prompt !== undefined || STANDARD_TEMPLATE_IDS.includes(value.template)) return;
    ctx.addIssue({
      code: "custom",
      message: `prompt is required unless template is one of: ${STANDARD_TEMPLATE_IDS.join(", ")}`,
    });
  });

/** What the create transaction returns: the caller's result plus the audit
 *  entry to record once the transaction has committed. */
type TxOutcome = Promise<{
  result: ServiceResult<DetectorCreated>;
  audit?: AuditEntry;
}>;

export async function createDetector(input: {
  actorUserId: string;
  projectId: string;
  name: string;
  template: string;
  prompt?: string;
  sampleRate?: number;
  outputSchema?: unknown[];
  triggerConditions?: unknown[];
  detectionSource?: "system" | "byok" | null;
  detectionModel?: string | null;
  detectionProvider?: string | null;
  enableRca?: boolean;
  enabled?: boolean;
  provenance: Provenance;
}): Promise<ServiceResult<DetectorCreated>> {
  // The transaction hands the audit entry back rather than writing it: a failed
  // audit INSERT would abort the transaction and discard the detector.
  let outcome: Awaited<TxOutcome>;
  try {
    outcome = await prisma.$transaction(async (tx): TxOutcome => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        select: { workspaceId: true, deleteTime: true },
      });
      if (!project || project.deleteTime !== null) {
        return {
          result: { ok: false, status: 404, error: "Project not found" },
        };
      }
      const member = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: project.workspaceId,
            userId: input.actorUserId,
          },
        },
        select: { role: true },
      });
      if (!member) {
        // Same status and message as a missing project: a 403 here would tell a
        // signed-in outsider that the project id exists in someone else's
        // workspace, which the read paths deliberately never reveal.
        return {
          result: { ok: false, status: 404, error: "Project not found" },
        };
      }
      if (!hasMinRole(member.role, Role.MEMBER)) {
        return {
          result: { ok: false, status: 403, error: "Requires MEMBER role or higher" },
        };
      }

      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          result: { ok: false, status: 400, error: parsed.error.issues[0].message },
        };
      }
      const { name, template, detectionSource, enableRca, enabled } = parsed.data;
      let prompt = parsed.data.prompt;
      let outputSchema = parsed.data.outputSchema;
      if (prompt === undefined) {
        // The schema rule only lets prompt be absent for a standard template,
        // so the canonical lookup cannot miss. A supplied outputSchema still
        // wins over the template's.
        const canonical = getTemplate(template)!;
        prompt = canonical.prompt;
        outputSchema = outputSchema ?? canonical.outputSchema;
      }
      const triggerConditions = (parsed.data.triggerConditions as unknown[] | undefined) ?? [];
      const resolvedSampleRate = parsed.data.sampleRate ?? DEFAULT_DETECTOR_SAMPLE_RATE;
      // A detector created at 0% sampling should not show as "enabled but never
      // fires" — default enabled to sampleRate > 0 so it starts paused instead.
      const resolvedEnabled = enabled ?? resolvedSampleRate > 0;

      // A model the workspace cannot run fails here, not on the detector's
      // first evaluation: the message lists what it can run, so a caller
      // that guessed an id (an agent, a script) can retry with a real one.
      // Reading the list is skipped for the plain default choice; a provider
      // beside a system model is not checked because the picker sends the
      // system provider's name there, and the worker ignores it.
      if (parsed.data.detectionModel || detectionSource === "byok") {
        const problem = detectorModelProblem(
          parsed.data,
          await listWorkspaceModels(project.workspaceId, { db: tx }),
        );
        if (problem !== null) {
          return { result: { ok: false, status: 400, error: problem } };
        }
      }

      // Idempotent create: a detector with the same name in this project is
      // returned as-is, so agent/CLI retries can't fan out duplicates. This
      // findFirst is the fast path; uq_detector_project_name is the backstop
      // that makes the idempotency atomic under concurrency.
      const existing = await tx.detector.findFirst({
        where: { projectId: input.projectId, name },
        select: { id: true, name: true, projectId: true, enabled: true, sampleRate: true },
      });
      if (existing) {
        return { result: { ok: true, created: false, data: existing } };
      }

      const detector = await tx.detector.create({
        data: {
          projectId: input.projectId,
          name,
          template,
          prompt,
          outputSchema: (outputSchema ?? []) as object,
          sampleRate: resolvedSampleRate,
          enabled: resolvedEnabled,
          enableRca: enableRca ?? true,
          detectionModel: parsed.data.detectionModel || null,
          detectionProvider: parsed.data.detectionProvider || null,
          detectionSource: detectionSource ?? null,
          ...(triggerConditions.length > 0
            ? { trigger: { create: { conditions: triggerConditions as object } } }
            : {}),
        },
        select: { id: true, name: true, projectId: true, enabled: true, sampleRate: true },
      });
      return {
        result: { ok: true, created: true, data: detector },
        audit: {
          actorUserId: input.actorUserId,
          operation: "create_detector",
          resourceType: "detector",
          resourceId: detector.id,
          workspaceId: project.workspaceId,
          projectId: input.projectId,
          summary: {
            name,
            template,
            sampleRate: resolvedSampleRate,
            enabled: resolvedEnabled,
          },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (!isPrismaKnownError(e, "P2002")) throw e;
    // A concurrent identical create won the race on the unique index.
    // Postgres aborts the losing transaction, so re-read after rollback and
    // answer idempotently, exactly as the fast path would have. The create
    // only ran after validation, so the parsed name is the raw input name.
    const raced = await prisma.detector.findFirst({
      where: { projectId: input.projectId, name: input.name },
      select: { id: true, name: true, projectId: true, enabled: true, sampleRate: true },
    });
    if (!raced) throw e;
    return { ok: true, created: false, data: raced };
  }

  const { result, audit } = outcome;
  if (audit) {
    await writeAudit(prisma, audit);
  }
  return result;
}

// The cookie route's per-field rules and messages, as a schema. Every field
// optional; `template` has no slot because it is set at creation and never
// changes. The detection fields accept null and "" as "unset", as the cookie
// route always has; name and prompt must be non-empty strings.
const detectionSourceMessage = 'detectionSource must be "system" or "byok"';
const patchSchema = z.object({
  name: nonEmptyString("name").optional(),
  prompt: nonEmptyString("prompt").optional(),
  outputSchema: z.array(z.unknown(), "outputSchema must be an array").optional(),
  sampleRate: sampleRateSchema.optional(),
  enabled: z.boolean("enabled must be a boolean").optional(),
  enableRca: z.boolean("enableRca must be a boolean").optional(),
  triggerConditions: triggerConditionsSchema,
  detectionModel: z.string("detectionModel must be a string").nullable().optional(),
  detectionProvider: z.string("detectionProvider must be a string").nullable().optional(),
  detectionSource: z
    .union(
      [z.literal("system"), z.literal("byok"), z.literal(""), z.null()],
      detectionSourceMessage,
    )
    .optional(),
});

/** The fields a detector patch may carry; validated by `patchSchema` at the call. */
export interface DetectorPatch {
  name?: string;
  prompt?: string;
  outputSchema?: unknown[];
  sampleRate?: number;
  enabled?: boolean;
  enableRca?: boolean;
  triggerConditions?: unknown[];
  detectionModel?: string | null;
  detectionProvider?: string | null;
  detectionSource?: "system" | "byok" | "" | null;
}

/** The detector as the reads return it: the row with its trigger. */
export type DetectorRecord = Detector & { trigger: DetectorTrigger | null };

const DETECTOR_NOT_FOUND = { ok: false, status: 404, error: "Detector not found" } as const;
const DETECTOR_NAME_TAKEN = {
  ok: false,
  status: 409,
  error: "A detector with this name already exists",
} as const;

/**
 * Whether a P2002 is the per-project name index. The trigger upsert can raise
 * its own P2002 (racing a concurrent first insert on the trigger's
 * detector-id key) even when the patch carries a name, so discriminate by
 * the violated constraint: Prisma reports it as the index name or as the
 * (projectId, name) fields, and only the name index mentions "name".
 */
const isNameCollision = (e: unknown) =>
  isPrismaKnownError(e, "P2002") && prismaErrorTarget(e).includes("name");

/**
 * Partially update a detector for a MEMBER of its project. Trigger conditions
 * replace the whole trigger through the nested relation; an empty array
 * removes it. Flipping `enabled` only writes the column: detection is
 * ingestion-triggered, so enabling starts nothing retroactively.
 */
export async function updateDetector(input: {
  actorUserId: string;
  projectId: string;
  detectorId: string;
  patch: DetectorPatch;
  provenance: Provenance;
}): Promise<UpdateResult<DetectorRecord>> {
  let outcome: Awaited<EditOutcome<UpdateResult<DetectorRecord>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<DetectorRecord>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = patchSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const { triggerConditions, detectionModel, detectionProvider, detectionSource, ...rest } =
        parsed.data;
      const patch = {
        ...rest,
        // Falsy reads as "unset" on the detection fields, as on the create.
        detectionModel: detectionModel === undefined ? undefined : detectionModel || null,
        detectionProvider: detectionProvider === undefined ? undefined : detectionProvider || null,
        detectionSource: detectionSource === undefined ? undefined : detectionSource || null,
        triggerConditions: triggerConditions as unknown[] | undefined,
      };
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }

      const existing = await tx.detector.findFirst({
        where: { id: input.detectorId, projectId: input.projectId },
        include: { trigger: true },
      });
      if (!existing) return { result: DETECTOR_NOT_FOUND };

      const { changed, data } = diffPatch(patch, {
        ...existing,
        triggerConditions: existing.trigger?.conditions ?? [],
      });
      if (changed.length === 0) return { result: { ok: true, data: existing, changed } };

      const { triggerConditions: conditions, ...columns } = data;
      const detector = await tx.detector.update({
        where: { id: existing.id },
        data: {
          ...(columns as Omit<typeof columns, "outputSchema"> & { outputSchema?: object }),
          ...(conditions === undefined
            ? {}
            : conditions.length > 0
              ? {
                  trigger: {
                    upsert: {
                      create: { conditions: conditions as object },
                      update: { conditions: conditions as object },
                    },
                  },
                }
              : { trigger: { delete: true } }),
        },
        include: { trigger: true },
      });
      return {
        result: { ok: true, data: detector, changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_detector",
          resourceType: "detector",
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
    // Deleted concurrently between the scoped read and the write.
    if (isPrismaKnownError(e, "P2025")) return DETECTOR_NOT_FOUND;
    if (isNameCollision(e)) return DETECTOR_NAME_TAKEN;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Hard-delete a detector for a MEMBER of its project. Existing findings keep
 * their detector id and stay readable.
 */
export async function deleteDetector(input: {
  actorUserId: string;
  projectId: string;
  detectorId: string;
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

      const existing = await tx.detector.findFirst({
        where: { id: input.detectorId, projectId: input.projectId },
      });
      if (!existing) return { result: DETECTOR_NOT_FOUND };

      await tx.detector.delete({ where: { id: existing.id } });
      return {
        result: { ok: true, data: { id: existing.id, name: existing.name }, reason: reason.reason },
        audit: {
          actorUserId: input.actorUserId,
          operation: "delete_detector",
          resourceType: "detector",
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
    if (isPrismaKnownError(e, "P2025")) return DETECTOR_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
