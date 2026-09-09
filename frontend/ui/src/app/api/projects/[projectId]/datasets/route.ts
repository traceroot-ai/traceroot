import { NextRequest } from "next/server";
import { prisma, Role, CreateDatasetRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { stableDatasetId } from "@/lib/eval/dataset-id";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/datasets — list datasets with case/version counts.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
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
          { description: { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }
    : { projectId };

  const [datasets, total] = await prisma.$transaction([
    prisma.dataset.findMany({
      where,
      orderBy: { updateTime: "desc" },
      skip: page * limit,
      take: limit,
      include: { _count: { select: { versions: true } } },
    }),
    prisma.dataset.count({ where }),
  ]);

  // Test-case count comes from each dataset's current version (a version with no
  // rows counts as 0). One groupBy instead of N per-dataset counts.
  const currentVersionIds = datasets
    .map((d) => d.currentVersionId)
    .filter((id): id is string => Boolean(id));
  const caseCounts =
    currentVersionIds.length > 0
      ? await prisma.testCase.groupBy({
          by: ["datasetVersionId"],
          where: { datasetVersionId: { in: currentVersionIds } },
          _count: { _all: true },
        })
      : [];
  const caseCountByVersion = new Map(caseCounts.map((c) => [c.datasetVersionId, c._count._all]));

  const data = datasets.map((d) => ({
    ...d,
    caseCount: d.currentVersionId ? (caseCountByVersion.get(d.currentVersionId) ?? 0) : 0,
    versionCount: d._count.versions,
  }));

  return successResponse({ data, meta: { page, limit, total } });
}

// POST /api/projects/[projectId]/datasets — create an (empty) dataset.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = CreateDatasetRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);

  // A dataset's identity is its key — its name, by convention. We derive the stable
  // client id the SAME way the SDK does (`ds_ = "ds_" + sha256(name)[:26]`, see
  // stableDatasetId), so a dataset created here and one pushed from the SDK under the
  // same name converge onto a single `(projectId, clientDatasetId)` row. Creating a
  // name that already resolves to an existing dataset therefore OPENS it (idempotent),
  // rather than erroring — same name means the same dataset. `key` is stored as the
  // stable pre-image; the display `name` may later be renamed without changing identity.
  const key = parsed.data.name;
  const clientDatasetId = stableDatasetId(key);

  const existing = await prisma.dataset.findUnique({
    where: { projectId_clientDatasetId: { projectId, clientDatasetId } },
  });
  if (existing) return successResponse({ dataset: existing, created: false }, 200);

  try {
    const dataset = await prisma.dataset.create({
      data: {
        projectId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        key,
        clientDatasetId,
      },
    });
    return successResponse({ dataset, created: true }, 201);
  } catch (e) {
    // A concurrent create of the same name won the race on the (projectId,
    // clientDatasetId) unique; re-read and answer idempotently by opening the existing one.
    if (isPrismaKnownError(e, "P2002")) {
      const raced = await prisma.dataset.findUnique({
        where: { projectId_clientDatasetId: { projectId, clientDatasetId } },
      });
      if (raced) return successResponse({ dataset: raced, created: false }, 200);
    }
    throw e;
  }
}
