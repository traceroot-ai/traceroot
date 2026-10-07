import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteAlert, updateAlert } from "@/lib/write-services/alerts";

type RouteParams = { params: Promise<{ id: string }> };

// Envelope-level checks only: the rule patch itself is validated by the
// write service, merged with the stored rule, whose 400s pass through
// unchanged.
const patchSchema = z.object(projectEnvelopeShape);

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope and reason as a JSON body; only the public surface avoids one.
const deleteSchema = z.object({ ...projectEnvelopeShape, reason: requiredId("reason") });

// PATCH /api/internal/write/alerts/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId } = parsed.data;
  // The envelope fields ride alongside the rule patch in one flat body; the
  // rule schema ignores keys it does not declare, so they never reach storage.
  const result = await updateAlert({
    actorUserId,
    projectId,
    alertId: id,
    patch: parsed.raw,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({
    updated: true,
    changed: result.changed,
    stateReset: result.stateReset ?? false,
    pageCleared: result.pageCleared ?? false,
    alert: result.data,
  });
}

// DELETE /api/internal/write/alerts/[id] — trusted-caller delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, reason } = parsed.data;
  const result = await deleteAlert({
    actorUserId,
    projectId,
    alertId: id,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({
    deleted: true,
    reason: result.reason,
    pageCleared: result.pageCleared ?? false,
    alert: result.data,
  });
}
