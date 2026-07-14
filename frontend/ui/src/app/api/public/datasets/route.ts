import { NextResponse } from "next/server";
import { prisma, type Prisma, PublicUpsertDatasetRequestSchema } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
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
    datasets: page.map((d) => ({
      // The id the SDK addresses this dataset by: its own, or the row id for a
      // dataset created in the UI. next_cursor stays an opaque row id.
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
// here (see .../versions).
//
// The client id is stored in `clientDatasetId`, unique per project — NOT as the
// primary key. As a global PK one tenant could POST a handful of plausible names
// ("prod-eval", "golden-set") and permanently block every other tenant from
// creating them. Scoped to the project, two tenants can each own "prod-eval" and
// neither can observe the other's.
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

  const key = { projectId, clientDatasetId: c.dataset_id };
  const select = { id: true, name: true, description: true, currentVersionId: true };

  const existing = await prisma.dataset.findUnique({
    where: { projectId_clientDatasetId: key },
    select,
  });
  if (existing) {
    return NextResponse.json(
      {
        dataset_id: c.dataset_id,
        name: existing.name,
        description: existing.description,
        current_dataset_version_id: existing.currentVersionId,
      },
      { status: 200 },
    );
  }

  try {
    const created = await prisma.dataset.create({
      data: {
        ...key,
        name: c.name,
        description: c.description ?? null,
        metadata: (c.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select,
    });
    return NextResponse.json(
      {
        dataset_id: c.dataset_id,
        name: created.name,
        description: created.description,
        current_dataset_version_id: created.currentVersionId,
      },
      { status: 201 },
    );
  } catch (err) {
    // Two first-time upserts of the same id raced: uq_dataset_project_client_id
    // rejected the loser. Re-read and answer as the idempotent 200 this promises.
    if (!isPrismaKnownError(err, "P2002")) throw err;
    const raced = await prisma.dataset.findUnique({
      where: { projectId_clientDatasetId: key },
      select,
    });
    if (!raced) throw err;
    return NextResponse.json(
      {
        dataset_id: c.dataset_id,
        name: raced.name,
        description: raced.description,
        current_dataset_version_id: raced.currentVersionId,
      },
      { status: 200 },
    );
  }
}
