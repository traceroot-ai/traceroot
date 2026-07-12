import { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
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
