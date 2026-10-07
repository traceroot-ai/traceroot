import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  envelopeShape,
  parseInternalWrite,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteProject, updateProject } from "@/lib/write-services/projects";

type RouteParams = { params: Promise<{ id: string }> };

// Shape-level checks only: the ranges and exact messages live in the write
// service. The project id is the path; its workspace is resolved from the
// row through the actor's membership. Only name and the retention are
// exposed: the RCA model settings and the alert delivery settings stay the
// web app's for now, and can be added as fields later.
const patchSchema = z.object({
  ...envelopeShape,
  name: z.string().optional(),
  traceTtlDays: z.number().nullable().optional(),
});

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope and reason as a JSON body; only the public surface avoids one.
const deleteSchema = z.object({ ...envelopeShape, reason: requiredId("reason") });

// PATCH /api/internal/write/projects/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, transport, agentSessionId, ...patch } = parsed.data;
  const result = await updateProject({
    actorUserId,
    projectId: id,
    patch,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, project: result.data });
}

// DELETE /api/internal/write/projects/[id] — trusted-caller soft delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, transport, agentSessionId, reason } = parsed.data;
  const result = await deleteProject({
    actorUserId,
    projectId: id,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ deleted: true, reason: result.reason, project: result.data });
}
