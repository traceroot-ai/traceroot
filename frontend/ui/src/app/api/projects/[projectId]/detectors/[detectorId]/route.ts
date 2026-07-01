import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import {
  DETECTOR_MODEL_SELECTION_REQUIRED_ERROR,
  validateDetectorModelSelection,
} from "../model-selection";

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
    enableRca,
    triggerConditions,
    detectionModel,
    detectionProvider,
    detectionSource,
  } = body as Record<string, unknown>;

  // Validate types up-front so invalid payloads return 400 instead of crashing
  // Prisma later. `Boolean(enabled)` would coerce strings like "false" to true;
  // require a strict boolean. sampleRate must be an integer 0-100.
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return errorResponse("enabled must be a boolean", 400);
  }
  if (enableRca !== undefined && typeof enableRca !== "boolean") {
    return errorResponse("enableRca must be a boolean", 400);
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

  // String field type checks — reject invalid types up front instead of
  // letting Prisma throw on the update. Required fields (name, prompt) must be
  // non-empty strings. Model-selection fields are merged with existing values
  // below and, when touched, must resolve to a complete valid tuple; explicit
  // "" / null clears therefore fail with the model-selection validation error.
  for (const [key, val] of [
    ["name", name],
    ["prompt", prompt],
    ["detectionModel", detectionModel],
    ["detectionProvider", detectionProvider],
    ["detectionSource", detectionSource],
  ] as const) {
    if (val !== undefined && val !== null && typeof val !== "string") {
      return errorResponse(`${key} must be a string`, 400);
    }
  }
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    return errorResponse("name must be a non-empty string", 400);
  }
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim().length === 0)) {
    return errorResponse("prompt must be a non-empty string", 400);
  }

  let sourceStr: "system" | "byok" | null | undefined;
  if (detectionSource !== undefined) {
    if (detectionSource === null || detectionSource === "") {
      sourceStr = null;
    } else if (detectionSource === "system" || detectionSource === "byok") {
      sourceStr = detectionSource;
    } else {
      return errorResponse(`detectionSource must be "system" or "byok"`, 400);
    }
  }

  const touchesModelSelection =
    detectionModel !== undefined ||
    detectionProvider !== undefined ||
    detectionSource !== undefined;

  // Build detector update data (only include defined fields)
  // Note: template is not updatable - it's set at creation time and cannot be changed
  const detectorData: Record<string, unknown> = {};
  if (name !== undefined) detectorData.name = name;
  if (prompt !== undefined) detectorData.prompt = prompt;
  if (outputSchema !== undefined) detectorData.outputSchema = outputSchema;
  if (sampleRate !== undefined) detectorData.sampleRate = sampleRate;
  if (enabled !== undefined) detectorData.enabled = enabled;
  if (enableRca !== undefined) detectorData.enableRca = enableRca;

  if (touchesModelSelection) {
    const nextModel =
      detectionModel !== undefined
        ? typeof detectionModel === "string"
          ? detectionModel.trim()
          : ""
        : existing.detectionModel?.trim() || "";
    const nextProvider =
      detectionProvider !== undefined
        ? typeof detectionProvider === "string"
          ? detectionProvider.trim()
          : ""
        : existing.detectionProvider?.trim() || "";
    const nextSource: "system" | "byok" | null =
      sourceStr !== undefined
        ? sourceStr
        : existing.detectionSource === "system" || existing.detectionSource === "byok"
          ? existing.detectionSource
          : null;

    if (!nextModel || !nextProvider || nextSource === null) {
      return errorResponse(DETECTOR_MODEL_SELECTION_REQUIRED_ERROR, 400);
    }

    const modelSelection = await validateDetectorModelSelection(accessResult.project.workspaceId, {
      model: nextModel,
      provider: nextProvider,
      source: nextSource,
    });
    if ("error" in modelSelection) {
      return errorResponse(modelSelection.error, 400);
    }

    detectorData.detectionModel = modelSelection.model;
    detectorData.detectionProvider = modelSelection.provider;
    detectorData.detectionSource = modelSelection.source;
  }

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
