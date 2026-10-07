import { NextResponse } from "next/server";
import { prisma, Prisma, PublicUpdateDatasetRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import { getDatasetDetail } from "@/lib/eval/dataset-read";
import { evalReadResponse } from "@/lib/eval/read-result";
import { resolvePublicDataset } from "@/lib/eval/versions";

type RouteParams = { params: Promise<{ datasetId: string }> };

// GET /api/public/datasets/[datasetId] — SDK fetches a dataset by stable id and
// learns its current published version to pin (API-key auth, snake_case body). The read
// is shared with the internal route (`getDatasetDetail`).
export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { datasetId } = await params;
  return evalReadResponse(await getDatasetDetail({ projectId: auth.projectId, datasetId }));
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

  const existing = await resolvePublicDataset(prisma, projectId, datasetId);
  if (!existing) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  const updated = await prisma.dataset.update({
    where: { id: existing.id },
    data: {
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
      // JsonB: an explicit null clears the column; an object replaces it.
      ...(c.metadata !== undefined
        ? { metadata: c.metadata === null ? Prisma.DbNull : (c.metadata as Prisma.InputJsonValue) }
        : {}),
    },
    select: { id: true, name: true, description: true, currentVersionId: true, key: true },
  });
  return NextResponse.json({
    dataset_id: datasetId,
    name: updated.name,
    description: updated.description,
    current_dataset_version_id: updated.currentVersionId,
    key: updated.key,
  });
}
