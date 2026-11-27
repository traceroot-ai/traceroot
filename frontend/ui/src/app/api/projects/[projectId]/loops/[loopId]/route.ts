import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { getLoopSummary } from "@traceroot/core/loops";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { requireLoopRoute } from "@/lib/loop-route";
import { parseJsonObject, readDeleteReason } from "@/lib/route-helpers";
import { deleteLoop, updateLoop } from "@/lib/write-services/loops";

type RouteParams = { params: Promise<{ projectId: string; loopId: string }> };

// GET /api/projects/[projectId]/loops/[loopId] - One Loop with its roll-ups
async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params);
  if (auth.error) return auth.error;

  const loop = await getLoopSummary(prisma, auth.projectId, auth.loop.id);
  if (!loop) return errorResponse("Loop not found", 404);
  return successResponse({ loop });
}

// PATCH /api/projects/[projectId]/loops/[loopId] - Partially update a Loop
async function handlePATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const parsed = await parseJsonObject(req);
  if (parsed.error) return parsed.error;

  const result = await updateLoop({
    actorUserId: auth.user.id,
    projectId: auth.projectId,
    loopId: auth.loop.id,
    patch: parsed.body,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ loop: result.data, changed: result.changed });
}

// DELETE /api/projects/[projectId]/loops/[loopId] - Delete a Loop; its hidden detector stays
async function handleDELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await requireLoopRoute(params, Role.MEMBER);
  if (auth.error) return auth.error;

  const result = await deleteLoop({
    actorUserId: auth.user.id,
    projectId: auth.projectId,
    loopId: auth.loop.id,
    reason: await readDeleteReason(req),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ deleted: true });
}

export const GET = withImpersonationPolicy(handleGET);
export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
