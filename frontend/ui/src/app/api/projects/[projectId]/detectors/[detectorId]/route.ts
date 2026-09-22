import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { readDeleteReason } from "@/lib/route-helpers";
import { deleteDetector, updateDetector, type DetectorPatch } from "@/lib/write-services/detectors";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId] - Get a single detector
async function handleGET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const detector = await prisma.detector.findFirst({
    where: { id: detectorId, projectId },
    include: { trigger: true },
  });

  if (!detector) {
    return errorResponse("Detector not found", 404);
  }

  return successResponse({ detector });
}

// PATCH /api/projects/[projectId]/detectors/[detectorId] - Partially update a detector.
// A thin adapter over the write service, which owns the per-field rules, the
// trigger registry check, the diff and the audit row; template is immutable
// and the service drops it.
async function handlePATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = await updateDetector({
    actorUserId: user.id,
    projectId,
    detectorId,
    patch: (body ?? {}) as DetectorPatch,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ detector: result.data });
}

// DELETE /api/projects/[projectId]/detectors/[detectorId] - Delete a detector
async function handleDELETE(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  const result = await deleteDetector({
    actorUserId: user.id,
    projectId,
    detectorId,
    reason: await readDeleteReason(req),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);
  return successResponse({ deleted: true });
}
export const GET = withImpersonationPolicy(handleGET);
export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
