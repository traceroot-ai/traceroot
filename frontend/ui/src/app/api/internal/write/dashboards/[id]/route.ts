import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteDashboard, updateDashboard } from "@/lib/write-services/dashboards";

type RouteParams = { params: Promise<{ id: string }> };

// Shape-level checks only: the length caps and exact messages live in the
// write service. `layout` has no slot: tile placement stays the web app's
// drag interaction.
const patchSchema = z.object({
  ...projectEnvelopeShape,
  name: z.string().optional(),
  description: z.string().nullable().optional(),
});

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope and reason as a JSON body; only the public surface avoids one.
const deleteSchema = z.object({ ...projectEnvelopeShape, reason: requiredId("reason") });

// PATCH /api/internal/write/dashboards/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, ...patch } = parsed.data;
  const result = await updateDashboard({
    actorUserId,
    projectId,
    dashboardId: id,
    patch,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, dashboard: result.data });
}

// DELETE /api/internal/write/dashboards/[id] — trusted-caller delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, reason } = parsed.data;
  const result = await deleteDashboard({
    actorUserId,
    projectId,
    dashboardId: id,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({
    deleted: true,
    reason: result.reason,
    cascaded: result.cascaded,
    dashboard: result.data,
  });
}
