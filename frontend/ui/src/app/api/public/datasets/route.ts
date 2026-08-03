import { NextResponse } from "next/server";
import { prisma, Prisma, PublicUpsertDatasetRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const n = Number(raw);
  // Floor first, THEN clamp: a positive fraction like 0.5 floors to 0, which would
  // produce an empty page while the cursor still dereferences its last row (a 500).
  const floored = Math.floor(n);
  if (!Number.isFinite(n) || floored < 1) return DEFAULT_LIMIT;
  return Math.min(floored, MAX_LIMIT);
}

// GET /api/public/datasets?limit=&cursor=&name= — list datasets (A1). Cursor is an
// opaque dataset id; results are newest-first with a null next_cursor at the end.
export async function GET(request: Request) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");
  const name = url.searchParams.get("name")?.trim();

  const rows = await prisma.dataset.findMany({
    where: {
      projectId,
      ...(name ? { name: { contains: name, mode: "insensitive" as Prisma.QueryMode } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      clientDatasetId: true,
      name: true,
      description: true,
      currentVersionId: true,
      updateTime: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return NextResponse.json({
    // `dataset_id` is the SDK-facing client id; the opaque `next_cursor` stays the
    // internal row id, which the SDK never interprets.
    datasets: page.map((d) => ({
      dataset_id: d.clientDatasetId ?? d.id,
      name: d.name,
      description: d.description,
      current_dataset_version_id: d.currentVersionId,
      updated_at: d.updateTime.toISOString(),
    })),
    next_cursor: hasMore ? page[page.length - 1].id : null,
  });
}

// POST /api/public/datasets — upsert a dataset by its client-generated id (A2).
// Idempotent within the project: re-sending the same dataset_id returns the
// existing dataset (200) without creating a duplicate; a version is never created
// here (see .../versions). An id owned by another project is 404 (not disclosed).
export async function POST(request: Request) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PublicUpsertDatasetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const c = parsed.data;

  // The SDK id is the project-scoped `clientDatasetId`, never the internal PK. Looking
  // up by `{ projectId, clientDatasetId }` keeps the keyspace per-tenant: two projects
  // can reuse the same id, and another project's id simply isn't found here (so we
  // create ours) rather than leaking its existence.
  const key = { projectId, clientDatasetId: c.dataset_id };
  const existing = await prisma.dataset.findUnique({
    where: { projectId_clientDatasetId: key },
    select: { id: true, clientDatasetId: true, name: true, description: true, currentVersionId: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        dataset_id: existing.clientDatasetId ?? existing.id,
        name: existing.name,
        description: existing.description,
        current_dataset_version_id: existing.currentVersionId,
      },
      { status: 200 },
    );
  }

  // Idempotent create: a concurrent first registration can lose the unique-key race
  // (both pass the read, one hits uq_dataset_project_client_id). Translate that P2002
  // into a re-read so a normal parallel retry returns 200, not a 500.
  try {
    const created = await prisma.dataset.create({
      data: {
        clientDatasetId: c.dataset_id,
        projectId,
        name: c.name,
        description: c.description ?? null,
        metadata: (c.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true, clientDatasetId: true, name: true, description: true, currentVersionId: true },
    });
    return NextResponse.json(
      {
        dataset_id: created.clientDatasetId ?? created.id,
        name: created.name,
        description: created.description,
        current_dataset_version_id: created.currentVersionId,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const won = await prisma.dataset.findUnique({
        where: { projectId_clientDatasetId: key },
        select: { id: true, clientDatasetId: true, name: true, description: true, currentVersionId: true },
      });
      if (won) {
        return NextResponse.json(
          {
            dataset_id: won.clientDatasetId ?? won.id,
            name: won.name,
            description: won.description,
            current_dataset_version_id: won.currentVersionId,
          },
          { status: 200 },
        );
      }
    }
    throw e;
  }
}
