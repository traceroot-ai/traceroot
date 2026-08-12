import { NextRequest } from "next/server";
import { prisma, Role, CreateDatasetRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";

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

  // A dataset's name is its human identity in the project: creating a second one with the
  // same name deduplicates against the first from the user's point of view, so deny it here
  // (case-insensitive) rather than silently making a confusing duplicate. Scoped to UI-authored
  // datasets (`clientDatasetId: null`) to match the partial unique index that backs it — an SDK
  // dataset may legitimately share a display name (it converges by its stable client id), so it
  // must not make this pre-check falsely 409 a valid UI create.
  const existing = await prisma.dataset.findFirst({
    where: {
      projectId,
      clientDatasetId: null,
      name: { equals: parsed.data.name, mode: "insensitive" as const },
    },
    select: { name: true },
  });
  if (existing) {
    return errorResponse(
      `A dataset named "${existing.name}" already exists in this project. Pick a different name.`,
      409,
    );
  }

  try {
    const dataset = await prisma.dataset.create({
      data: {
        projectId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      },
    });
    return successResponse({ dataset }, 201);
  } catch (e) {
    // Two concurrent creates can both clear the pre-check above; the partial unique index
    // (uq_dataset_project_lower_name_ui) is the race-safe backstop, so translate its
    // violation into the same 409 rather than letting it surface as a 500.
    if (isPrismaKnownError(e, "P2002")) {
      return errorResponse(
        `A dataset named "${parsed.data.name}" already exists in this project. Pick a different name.`,
        409,
      );
    }
    throw e;
  }
}
