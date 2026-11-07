import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteDetector, updateDetector } from "@/lib/write-services/detectors";

type RouteParams = { params: Promise<{ id: string }> };

// Shape-level checks only: the per-field rules, the trigger registry and the
// exact messages live in the write service. `template` is immutable and has
// no slot here; the nullable fields take null to clear.
const patchSchema = z.object({
  ...projectEnvelopeShape,
  name: z.string().optional(),
  prompt: z.string().optional(),
  enabled: z.boolean().optional(),
  sampleRate: z.number().optional(),
  enableRca: z.boolean().optional(),
  outputSchema: z.array(z.unknown(), "outputSchema must be an array").optional(),
  triggerConditions: z.array(z.unknown(), "triggerConditions must be an array").optional(),
  detectionSource: z.union([z.literal("system"), z.literal("byok"), z.null()]).optional(),
  detectionModel: z.string().nullable().optional(),
  detectionProvider: z.string().nullable().optional(),
});

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope and reason as a JSON body; only the public surface avoids one.
const deleteSchema = z.object({ ...projectEnvelopeShape, reason: requiredId("reason") });

// PATCH /api/internal/write/detectors/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, ...patch } = parsed.data;
  const result = await updateDetector({
    actorUserId,
    projectId,
    detectorId: id,
    patch,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, detector: result.data });
}

// DELETE /api/internal/write/detectors/[id] — trusted-caller delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, reason } = parsed.data;
  const result = await deleteDetector({
    actorUserId,
    projectId,
    detectorId: id,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ deleted: true, reason: result.reason, detector: result.data });
}
