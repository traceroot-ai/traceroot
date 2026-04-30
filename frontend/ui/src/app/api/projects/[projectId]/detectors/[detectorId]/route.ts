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
    include: { trigger: true },
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
    detectionModel,
    detectionProvider,
    detectionAdapter,
  } = body as Record<string, unknown>;

  // Validate types up-front so invalid payloads return 400 instead of crashing
  // Prisma later. `Boolean(enabled)` would coerce strings like "false" to true;
  // require a strict boolean. sampleRate must be an integer 0-100.
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return errorResponse("enabled must be a boolean", 400);
  }
  if (sampleRate !== undefined) {
    if (
      typeof sampleRate !== "number" ||
      !Number.isInteger(sampleRate) ||
      sampleRate < 0 ||
      sampleRate > 100
    ) {
      return errorResponse("sampleRate must be an integer between 0 and 100", 400);
    }
  }
  if (triggerConditions !== undefined && !Array.isArray(triggerConditions)) {
    return errorResponse("triggerConditions must be an array", 400);
  }
  if (outputSchema !== undefined && !Array.isArray(outputSchema)) {
    return errorResponse("outputSchema must be an array", 400);
  }

  // Build detector update data (only include defined fields)
  // Note: template is not updatable - it's set at creation time and cannot be changed
  const detectorData: Record<string, unknown> = {};
  if (name !== undefined) detectorData.name = name;
  if (prompt !== undefined) detectorData.prompt = prompt;
  if (outputSchema !== undefined) detectorData.outputSchema = outputSchema;
  if (sampleRate !== undefined) detectorData.sampleRate = sampleRate;
  if (enabled !== undefined) detectorData.enabled = enabled;
  if (detectionModel !== undefined) detectorData.detectionModel = detectionModel || null;
  if (detectionProvider !== undefined) detectorData.detectionProvider = detectionProvider || null;
  if (detectionAdapter !== undefined) detectorData.detectionAdapter = detectionAdapter || null;

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
    },
    include: { trigger: true },
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
