import { NextResponse } from "next/server";
import { prisma, Prisma, PublicUpdateDatasetRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

type RouteParams = { params: Promise<{ datasetId: string }> };

// GET /api/public/datasets/[datasetId] — SDK fetches a dataset by stable id and
// learns its current published version to pin (API-key auth, snake_case body).
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { datasetId } = await params;

  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true, name: true, description: true, currentVersionId: true },
  });
  if (!dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  return NextResponse.json({
    dataset_id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    current_dataset_version_id: dataset.currentVersionId,
  });
}

// PATCH /api/public/datasets/[datasetId] — dataset metadata only (A3). Never
// mutates a published version; publish test-case changes via .../versions.
export async function PATCH(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;
  const { datasetId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PublicUpdateDatasetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const c = parsed.data;

  const existing = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  const updated = await prisma.dataset.update({
    where: { id: datasetId },
    data: {
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
      // JsonB: an explicit null clears the column; an object replaces it.
      ...(c.metadata !== undefined
        ? { metadata: c.metadata === null ? Prisma.DbNull : (c.metadata as Prisma.InputJsonValue) }
        : {}),
    },
    select: { id: true, name: true, description: true, currentVersionId: true },
  });
  return NextResponse.json({
    dataset_id: updated.id,
    name: updated.name,
    description: updated.description,
    current_dataset_version_id: updated.currentVersionId,
  });
}
