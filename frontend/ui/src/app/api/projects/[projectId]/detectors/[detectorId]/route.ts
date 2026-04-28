import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; detectorId: string }> };

// GET /api/projects/[projectId]/detectors/[detectorId] - Get a single detector
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const detector = await prisma.detector.findFirst({
    where: { id: detectorId, projectId },
    include: { trigger: true, alertConfig: true },
  });

  if (!detector) {
    return errorResponse("Detector not found", 404);
  }

  return successResponse({ detector });
}

// PATCH /api/projects/[projectId]/detectors/[detectorId] - Partially update a detector
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const existing = await prisma.detector.findFirst({
    where: { id: detectorId, projectId },
  });

  if (!existing) {
    return errorResponse("Detector not found", 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const {
    name,
    template: _template,
    prompt,
    outputSchema,
    sampleRate,
    enabled,
    triggerConditions,
    emailAddresses,
    autoRca,
    detectionModel,
    detectionProvider,
    detectionAdapter,
  } = body as Record<string, unknown>;

  // Build detector update data (only include defined fields)
  // Note: template is not updatable - it's set at creation time and cannot be changed
  const detectorData: Record<string, unknown> = {};
  if (name !== undefined) detectorData.name = name;
  if (prompt !== undefined) detectorData.prompt = prompt;
  if (outputSchema !== undefined) detectorData.outputSchema = outputSchema;
  if (sampleRate !== undefined) detectorData.sampleRate = sampleRate;
  if (enabled !== undefined) detectorData.enabled = Boolean(enabled);
  if (detectionModel !== undefined) detectorData.detectionModel = detectionModel || null;
  if (detectionProvider !== undefined) detectorData.detectionProvider = detectionProvider || null;
  if (detectionAdapter !== undefined) detectorData.detectionAdapter = detectionAdapter || null;

  // Build alert config update data
  const alertConfigData: Record<string, unknown> = {};
  if (emailAddresses !== undefined) {
    if (!Array.isArray(emailAddresses)) {
      return errorResponse("emailAddresses must be an array", 400);
    }
    alertConfigData.emailAddresses = emailAddresses;
  }
  if (autoRca !== undefined) alertConfigData.autoRca = Boolean(autoRca);

  const detector = await prisma.detector.update({
    where: { id: detectorId },
    data: {
      ...detectorData,
      ...(triggerConditions !== undefined
        ? {
            trigger: {
              upsert: {
                create: { conditions: triggerConditions as object },
                update: { conditions: triggerConditions as object },
              },
            },
          }
        : {}),
      ...(Object.keys(alertConfigData).length > 0
        ? {
            alertConfig: {
              upsert: {
                create: { emailAddresses: [], ...alertConfigData },
                update: alertConfigData,
              },
            },
          }
        : {}),
    },
    include: { trigger: true, alertConfig: true },
  });

  return successResponse({ detector });
}

// DELETE /api/projects/[projectId]/detectors/[detectorId] - Delete a detector
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId, detectorId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const existing = await prisma.detector.findFirst({
    where: { id: detectorId, projectId },
  });

  if (!existing) {
    return errorResponse("Detector not found", 404);
  }

  await prisma.detector.delete({ where: { id: detectorId } });

  return successResponse({ deleted: true });
}
