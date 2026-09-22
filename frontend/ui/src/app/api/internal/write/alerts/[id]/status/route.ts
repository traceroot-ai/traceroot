import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  requiredId,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { setAlertStatus } from "@/lib/write-services/alerts";

type RouteParams = { params: Promise<{ id: string }> };

// Presence only: which statuses are settable is the write service's rule,
// whose 400 passes through unchanged.
const bodySchema = z.object({ ...projectEnvelopeShape, status: requiredId("status") });

// PATCH /api/internal/write/alerts/[id]/status — trusted-caller pause or
// resume. Status only, so it never round-trips the rule payload.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, status } = parsed.data;
  const result = await setAlertStatus({
    actorUserId,
    projectId,
    alertId: id,
    status,
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
