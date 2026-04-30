import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/detectors - List all detectors for the project
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const detectors = await prisma.detector.findMany({
    where: { projectId },
    include: { trigger: true },
    orderBy: { createTime: "asc" },
  });

  return successResponse({ detectors });
}

// POST /api/projects/[projectId]/detectors - Create a new detector
export async function POST(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const {
    name,
    template,
    prompt,
    outputSchema,
    sampleRate = 100,
    triggerConditions,
    detectionModel,
    detectionProvider,
    detectionAdapter,
  } = body as Record<string, unknown>;

  if (!name || !template || !prompt) {
    return errorResponse("name, template, and prompt are required", 400);
  }

  // Validate sampleRate (integer 0-100). Fall back to 100 only when omitted.
  let resolvedSampleRate = 100;
  if (sampleRate !== undefined) {
    if (
      typeof sampleRate !== "number" ||
      !Number.isInteger(sampleRate) ||
      sampleRate < 0 ||
      sampleRate > 100
    ) {
      return errorResponse("sampleRate must be an integer between 0 and 100", 400);
    }
    resolvedSampleRate = sampleRate;
  }

  // Validate triggerConditions and outputSchema are arrays when provided —
  // a non-array object would otherwise silently produce an empty list and
  // cause the detector to fire on every trace.
  if (triggerConditions !== undefined && !Array.isArray(triggerConditions)) {
    return errorResponse("triggerConditions must be an array", 400);
  }
  if (outputSchema !== undefined && !Array.isArray(outputSchema)) {
    return errorResponse("outputSchema must be an array", 400);
  }

  const detector = await prisma.detector.create({
    data: {
      projectId,
      name: name as string,
      template: template as string,
      prompt: prompt as string,
      outputSchema: (outputSchema as object) ?? [],
      sampleRate: resolvedSampleRate,
      detectionModel: typeof detectionModel === "string" && detectionModel ? detectionModel : null,
      detectionProvider:
        typeof detectionProvider === "string" && detectionProvider ? detectionProvider : null,
      detectionAdapter:
        typeof detectionAdapter === "string" && detectionAdapter ? detectionAdapter : null,
      trigger: {
        create: {
          conditions: (triggerConditions as object) ?? [
            { field: "root_span_finished", op: "=", value: true },
            { field: "total_tokens", op: ">", value: 1000 },
          ],
        },
      },
    },
    include: { trigger: true },
  });

  return successResponse({ detector }, 201);
}
