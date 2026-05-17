import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

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
    sampleRate = 100,
    triggerConditions,
    detectionModel,
    detectionProvider,
    detectionSource,
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
  const resolvedModel =
    typeof detectionModel === "string" && detectionModel ? detectionModel : null;
  const resolvedProvider =
    typeof detectionProvider === "string" && detectionProvider ? detectionProvider : null;

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
      detectionSource: sourceStr,
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
