import { prisma, Role, hasMinRole } from "@traceroot/core";
import { z } from "zod";
import { DEFAULT_DETECTOR_SAMPLE_RATE } from "@/features/detectors/templates";
import { validateTriggerConditions } from "@/features/detectors/trigger-fields";
import { writeAudit, type AuditEntry } from "./audit";
import type { Provenance, ServiceResult } from "./types";

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

// Mirrors the cookie route's validation verbatim so both write surfaces
// reject the same payloads with the same messages.
const inputSchema = z.object({
  name: nonEmptyString("name"),
  template: nonEmptyString("template"),
  prompt: nonEmptyString("prompt"),
  sampleRate: z
    .number(sampleRateMessage)
    .int(sampleRateMessage)
    .min(0, sampleRateMessage)
    .max(100, sampleRateMessage)
    .optional(),
  outputSchema: z.array(z.unknown(), "outputSchema must be an array").optional(),
  // Validated against the trigger-field registry — an unknown field or
  // operator would be stored fine but never match at evaluation time,
  // silently disabling the detector.
  triggerConditions: z.unknown().superRefine((value, ctx) => {
    if (value === undefined) return;
    const error = validateTriggerConditions(value);
    if (error) ctx.addIssue({ code: "custom", message: error });
  }),
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
  prompt: string;
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
  const { result, audit } = await prisma.$transaction(async (tx): TxOutcome => {
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
      return {
        result: { ok: false, status: 403, error: "Not a member of this workspace" },
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
    const { name, template, prompt, detectionSource, enableRca, enabled } = parsed.data;
    const triggerConditions = (parsed.data.triggerConditions as unknown[] | undefined) ?? [];
    const resolvedSampleRate = parsed.data.sampleRate ?? DEFAULT_DETECTOR_SAMPLE_RATE;
    // A detector created at 0% sampling should not show as "enabled but never
    // fires" — default enabled to sampleRate > 0 so it starts paused instead.
    const resolvedEnabled = enabled ?? resolvedSampleRate > 0;

    // Idempotent create: a detector with the same name in this project is
    // returned as-is, so agent/CLI retries can't fan out duplicates.
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
        outputSchema: (parsed.data.outputSchema ?? []) as object,
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

  if (audit) {
    await writeAudit(prisma, audit);
  }
  return result;
}
