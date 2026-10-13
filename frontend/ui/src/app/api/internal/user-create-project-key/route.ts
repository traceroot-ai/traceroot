import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import { generateApiKey, getKeyPrefix, hashApiKey } from "@/lib/api-keys";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const createKeySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  projectId: z.string().min(1, "projectId is required"),
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  /**
   * Defaults to `ingest`, matching `/api/public/api-keys`. The wizard asks for
   * `admin` explicitly, because it reads traces back to verify the first one
   * arrived — that should be a deliberate request, not a quiet default.
   */
  scope: z.enum(["ingest", "admin"]).optional(),
  expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
});

// POST /api/internal/user-create-project-key
//
// Mints a project API key for a userId the caller has ALREADY authenticated.
//
// This is what makes the second repository cheap. `/api/public/api-keys` already
// mints keys, but it authenticates with a key for the very project you are
// trying to get a key for — fine for rotation, useless when you have none yet.
//
// Deliberately narrow, for the same reason as user-create-project: a project's
// first key is the one key no project credential can mint. Trust is the
// X-Internal-Secret plus the backend's verified identity. Never log ids, and
// never log the minted secret.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { userId, projectId, name, expiresInDays } = parsed.data;
  const scope = parsed.data.scope ?? "ingest";

  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: { id: true, name: true, workspaceId: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // MEMBER, the same threshold the browser routes enforce.
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    select: { role: true },
  });
  if (!membership || membership.role === Role.VIEWER) {
    return NextResponse.json({ error: "Insufficient project permissions" }, { status: 403 });
  }

  const existing = await prisma.accessKey.findFirst({
    where: { projectId: project.id, name },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `An API key named '${name}' already exists in this project` },
      { status: 409 },
    );
  }

  const secret = generateApiKey();
  const expireTime =
    expiresInDays === null || expiresInDays === undefined
      ? null
      : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const created = await prisma.accessKey.create({
    data: {
      id: crypto.randomUUID(),
      projectId: project.id,
      secretHash: hashApiKey(secret),
      keyHint: getKeyPrefix(secret),
      name,
      scope,
      expireTime,
    },
    select: {
      id: true,
      keyHint: true,
      name: true,
      projectId: true,
      scope: true,
      expireTime: true,
      createTime: true,
    },
  });

  // `key` appears here and nowhere else, ever. Only the hash is stored.
  return NextResponse.json(
    {
      valid: true,
      id: created.id,
      name: created.name,
      hint: created.keyHint,
      project_id: created.projectId,
      project_name: project.name,
      scope: created.scope,
      expires_at: created.expireTime ? created.expireTime.toISOString() : null,
      created_at: created.createTime.toISOString(),
      key: secret,
    },
    { status: 201 },
  );
}
