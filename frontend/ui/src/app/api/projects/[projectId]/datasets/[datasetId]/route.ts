import { NextRequest } from "next/server";
import { prisma, Role, UpdateDatasetRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string; datasetId: string }> };

// GET — dataset detail: current version, its test cases, and the version list.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    include: {
      versions: { orderBy: { versionNumber: "desc" } },
    },
  });
  if (!dataset) return errorResponse("Dataset not found", 404);

  // Newest first for the UI table (latest-added test case at the top).
  const testCases = dataset.currentVersionId
    ? await prisma.testCase.findMany({
        where: { datasetVersionId: dataset.currentVersionId },
        orderBy: { createTime: "desc" },
      })
    : [];
  const currentVersion = dataset.versions.find((v) => v.id === dataset.currentVersionId) ?? null;

  return successResponse({ dataset, currentVersion, testCases, versions: dataset.versions });
}

// PATCH — update editable dataset metadata (not its snapshots).
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = UpdateDatasetRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);

  const existing = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true },
  });
  if (!existing) return errorResponse("Dataset not found", 404);

  const dataset = await prisma.dataset.update({
    where: { id: datasetId },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    },
  });
  return successResponse({ dataset });
}

// DELETE — remove the dataset (cascades versions/test cases).
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  const existing = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true },
  });
  if (!existing) return errorResponse("Dataset not found", 404);

  await prisma.dataset.delete({ where: { id: datasetId } });
  return successResponse({ deleted: true });
}
