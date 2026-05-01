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

  // `null` is valid JSON but not destructure-friendly. Reject explicitly.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Body must be a JSON object", 400);
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

  // Required fields must be non-empty strings (trim catches whitespace-only).
  if (typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("name must be a non-empty string", 400);
  }
  if (typeof template !== "string" || template.trim().length === 0) {
    return errorResponse("template must be a non-empty string", 400);
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return errorResponse("prompt must be a non-empty string", 400);
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

  // Adapter-aware defaults: when an adapter is selected but model/provider
  // are blank, fill in the canonical defaults for that adapter so worker-side
  // sandbox-eval doesn't have to fall back through `DETECTION_DEFAULTS`
  // (and won't accidentally route a Claude-default model through the OpenAI
  // SDK). Keep in sync with `frontend/worker/src/detection/sandbox-eval.ts`.
  const ADAPTER_DEFAULTS: Record<string, { model: string; provider: string }> = {
    anthropic: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
    openai: { model: "gpt-4o-mini", provider: "openai" },
  };
  const adapterStr =
    typeof detectionAdapter === "string" && detectionAdapter ? detectionAdapter : null;
  const adapterDefaults = adapterStr ? ADAPTER_DEFAULTS[adapterStr] : null;
  const resolvedModel =
    typeof detectionModel === "string" && detectionModel
      ? detectionModel
      : (adapterDefaults?.model ?? null);
  const resolvedProvider =
    typeof detectionProvider === "string" && detectionProvider
      ? detectionProvider
      : (adapterDefaults?.provider ?? null);

  const detector = await prisma.detector.create({
    data: {
      projectId,
      name,
      template,
      prompt,
      outputSchema: (outputSchema as object) ?? [],
      sampleRate: resolvedSampleRate,
      detectionModel: resolvedModel,
      detectionProvider: resolvedProvider,
      detectionAdapter: adapterStr,
      trigger: {
        create: {
          conditions: (triggerConditions as object) ?? [],
        },
      },
    },
    include: { trigger: true },
  });

  return successResponse({ detector }, 201);
}
