import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  serviceErrorResponse,
} from "@/lib/internal-write-route";
import { changeSignalStatus } from "@/ee/features/signals/write-service";

type RouteParams = { params: Promise<{ id: string }> };

// Presence only: which statuses and reasons are settable is the write
// service's rule, whose 400 passes through unchanged.
const bodySchema = z.object({
  ...projectEnvelopeShape,
  change: z.unknown(),
  expectedStatus: z.unknown().optional(),
});

// PATCH /api/internal/write/signals/[id]/status — trusted-caller resolve or
// reopen. "dismissed" is refused here; it stays a web-app decision.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const parsed = await parseInternalWrite(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { actorUserId, projectId, transport, agentSessionId, change, expectedStatus } = parsed.data;
  const result = await changeSignalStatus({
    actorUserId,
    projectId,
    signalId: id,
    change,
    expectedStatus,
    provenance: provenanceOf({ transport, agentSessionId }),
  });
  if (!result.ok) return serviceErrorResponse(result);
  return NextResponse.json({ updated: true, changed: result.changed, signal: result.data });
}
