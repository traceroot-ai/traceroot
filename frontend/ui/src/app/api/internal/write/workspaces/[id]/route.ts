import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  envelopeShape,
  parseInternalWrite,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { deleteWorkspace, updateWorkspace } from "@/lib/write-services/workspaces";

type RouteParams = { params: Promise<{ id: string }> };

// Shape-level checks only: the length cap and exact message live in the
// write service. The workspace id is the path; membership is the tenancy.
const patchSchema = z.object({ ...envelopeShape, name: z.string().optional() });

// Service-to-service over the app's own HTTP client, so the DELETE carries
// its envelope, the typed name and the reason as a JSON body; only the
// public surface avoids one.
const deleteSchema = z.object({
  ...envelopeShape,
  name: requiredId("name"),
  reason: requiredId("reason"),
});

// PATCH /api/internal/write/workspaces/[id] — trusted-caller partial update.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, transport, agentSessionId, ...patch } = parsed.data;
  const result = await updateWorkspace({
    actorUserId,
    workspaceId: id,
    patch,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, workspace: result.data });
}

// DELETE /api/internal/write/workspaces/[id] — trusted-caller hard delete.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, transport, agentSessionId, name, reason } = parsed.data;
  const result = await deleteWorkspace({
    actorUserId,
    workspaceId: id,
    name,
    reason,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({
    deleted: true,
    reason: result.reason,
    cascaded: result.cascaded,
    workspace: result.data,
  });
}
