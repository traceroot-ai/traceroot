import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteWidget, updateWidget } from "@/lib/write-services/dashboards";

type RouteParams = { params: Promise<{ id: string }> };

// Shape-level checks only: the dialect check against the stored type and the
// exact messages live in the write service. `type` is immutable and has no
// slot here; `displayConfig: null` resets it.
const patchSchema = z.object({
  ...projectEnvelopeShape,
  title: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  displayConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope and reason as a JSON body; only the public surface avoids one.
const deleteSchema = z.object({ ...projectEnvelopeShape, reason: requiredId("reason") });

// PATCH /api/internal/write/widgets/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, ...patch } = parsed.data;
  const result = await updateWidget({
    actorUserId,
    projectId,
    widgetId: id,
    patch,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, widget: result.data });
}

// DELETE /api/internal/write/widgets/[id] — trusted-caller delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, reason } = parsed.data;
  const result = await deleteWidget({
    actorUserId,
    projectId,
    widgetId: id,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ deleted: true, reason: result.reason, widget: result.data });
}
