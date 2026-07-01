import { NextRequest } from "next/server";
import {
  prisma,
  SYSTEM_MODELS,
  ADAPTER_MODELS,
  ModelSource,
  type LLMAdapter,
} from "@traceroot/core";
import { DEFAULT_DETECTOR_SAMPLE_RATE } from "@/features/detectors/templates";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

interface ResolvedDetectorModelSelection {
  model: string;
  provider: string;
  source: "system" | "byok";
}

function modelSelectionError(message: string): { error: string } {
  return { error: message };
}

async function validateDetectorModelSelection(
  workspaceId: string,
  selection: ResolvedDetectorModelSelection,
): Promise<ResolvedDetectorModelSelection | { error: string }> {
  const model = selection.model.trim();
  const provider = selection.provider.trim();

  if (selection.source === ModelSource.SYSTEM) {
    const normalizedProvider = provider.toLowerCase();
    const systemProvider = SYSTEM_MODELS.find(
      (candidate) =>
        candidate.provider.toLowerCase() === normalizedProvider ||
        candidate.piAIProvider.toLowerCase() === normalizedProvider,
    );

    if (!systemProvider || !process.env[systemProvider.envVar]) {
      return modelSelectionError("Selected system provider is not available for this workspace");
    }

    if (!systemProvider.models.some((candidate) => candidate.id === model)) {
      return modelSelectionError("Selected system model is not available for this workspace");
    }

    return { model, provider: systemProvider.provider, source: ModelSource.SYSTEM };
  }

  const byokProvider = await prisma.modelProvider.findFirst({
    where: { workspaceId, provider, enabled: true },
    select: { provider: true, adapter: true, customModels: true },
  });

  if (!byokProvider) {
    return modelSelectionError("Selected BYOK provider is not available for this workspace");
  }

  const configuredModels = byokProvider.customModels.map((id) => id.trim()).filter(Boolean);
  if (!configuredModels.includes(model)) {
    return modelSelectionError("Selected BYOK model is not configured for this provider");
  }

  const catalog = ADAPTER_MODELS[byokProvider.adapter as LLMAdapter];
  if (catalog && !catalog.some((candidate) => candidate.id === model)) {
    return modelSelectionError("Selected BYOK model is not supported by Traceroot");
  }

  return { model, provider: byokProvider.provider, source: ModelSource.BYOK };
}

// GET /api/projects/[projectId]/detectors - List detectors for the project.
// Supports `search_query` (substring on name/template/prompt), `page`, `limit`.
// Returns `{ data, meta }` to match the rest of the list endpoints.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const { projectId } = await params;
  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const page = isNaN(rawPage) ? 0 : Math.max(rawPage, 0);
  const searchQuery = searchParams.get("search_query")?.trim() || null;

  const where = searchQuery
    ? {
        projectId,
        OR: [
          { name: { contains: searchQuery, mode: "insensitive" as const } },
          { template: { contains: searchQuery, mode: "insensitive" as const } },
          { prompt: { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }
    : { projectId };

  const [data, total] = await prisma.$transaction([
    prisma.detector.findMany({
      where,
      include: { trigger: true },
      orderBy: { createTime: "asc" },
      skip: page * limit,
      take: limit,
    }),
    prisma.detector.count({ where }),
  ]);

  return successResponse({ data, meta: { page, limit, total } });
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
    sampleRate,
    enabled,
    triggerConditions,
    detectionModel,
    detectionProvider,
    detectionSource,
    enableRca,
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

  // Validate sampleRate (integer 0-100). Fall back to the default only when
  // omitted — kept light so new detectors don't run an LLM call on every trace.
  let resolvedSampleRate: number = DEFAULT_DETECTOR_SAMPLE_RATE;
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

  // detectionSource: only "system" / "byok" / null are valid. Reject anything
  // else with 400 so a typo (e.g. "syetm") doesn't silently store null and
  // produce a misconfigured detector.
  let sourceStr: "system" | "byok" | null = null;
  if (detectionSource !== undefined && detectionSource !== null) {
    if (detectionSource !== "system" && detectionSource !== "byok") {
      return errorResponse(`detectionSource must be "system" or "byok"`, 400);
    }
    sourceStr = detectionSource;
  }
  const hasModelSelection =
    typeof detectionModel === "string" &&
    detectionModel.trim().length > 0 &&
    typeof detectionProvider === "string" &&
    detectionProvider.trim().length > 0 &&
    sourceStr !== null;

  if (!hasModelSelection) {
    return errorResponse(
      "Detector model selection is required. Choose a configured system model or BYOK provider.",
      400,
    );
  }

  const modelSelection = await validateDetectorModelSelection(accessResult.project.workspaceId, {
    model: detectionModel as string,
    provider: detectionProvider as string,
    source: sourceStr,
  });
  if ("error" in modelSelection) {
    return errorResponse(modelSelection.error, 400);
  }

  // enableRca: optional boolean, defaults true (RCA on). Reject non-booleans
  // so "false"/0 can't silently coerce.
  if (enableRca !== undefined && typeof enableRca !== "boolean") {
    return errorResponse("enableRca must be a boolean", 400);
  }
  const resolvedEnableRca = enableRca ?? true;

  // enabled: optional boolean. Defaults to true, but a detector created at 0%
  // sampling should not show as "enabled but never fires" — fall back to
  // sampleRate > 0 so a 0% rate creates a paused detector.
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return errorResponse("enabled must be a boolean", 400);
  }
  const resolvedEnabled = enabled ?? resolvedSampleRate > 0;

  const detector = await prisma.detector.create({
    data: {
      projectId,
      name,
      template,
      prompt,
      outputSchema: (outputSchema as object) ?? [],
      sampleRate: resolvedSampleRate,
      enabled: resolvedEnabled,
      enableRca: resolvedEnableRca,
      detectionModel: modelSelection.model,
      detectionProvider: modelSelection.provider,
      detectionSource: modelSelection.source,
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
