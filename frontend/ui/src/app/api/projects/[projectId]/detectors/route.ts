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
    include: { trigger: true, alertConfig: true },
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
    emailAddresses,
    detectionModel,
    detectionProvider,
    detectionAdapter,
  } = body as Record<string, unknown>;

  if (!name || !template || !prompt) {
    return errorResponse("name, template, and prompt are required", 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detector = await (prisma.detector.create as any)({
    data: {
      projectId,
      name: name as string,
      template: template as string,
      prompt: prompt as string,
      outputSchema: (outputSchema as object) ?? [],
      sampleRate: typeof sampleRate === "number" ? sampleRate : 100,
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
      alertConfig: {
        create: {
          emailAddresses: Array.isArray(emailAddresses) ? (emailAddresses as string[]) : [],
        },
      },
    },
    include: { trigger: true, alertConfig: true },
  });

  return successResponse({ detector }, 201);
}
