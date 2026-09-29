import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { generateApiKey, getKeyPrefix, hashApiKey } from "@/lib/api-keys";
import { publicError, requireApiKeyProject } from "@/lib/public-auth";

/**
 * Public project API keys — list and create.
 *
 * Exists so a CLI or CI job can obtain a credential for the project it is
 * already authenticated against, instead of asking a human to copy one out of
 * the dashboard. `traceroot setup` uses it to give a repository its own key
 * rather than reusing the developer's.
 *
 * The authenticating key's project is the only project reachable here; there is
 * no `project_id` input to confuse or abuse. A key can therefore mint siblings
 * for its own project but can never reach another one.
 */

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  /**
   * Days until the new key expires. `null` means non-expiring, which is the
   * right default for an application credential: a key that silently expires
   * takes production tracing down at an arbitrary future date.
   */
  expires_in_days: z.number().int().positive().max(3650).nullable().optional(),
  /**
   * What the new key may do. Defaults to `ingest` — the credential a deployed
   * application carries should be able to send telemetry and nothing else, so
   * the safe scope is the one you get by not thinking about it.
   */
  scope: z.enum(["ingest", "admin"]).optional(),
});

/** Serialized key metadata. Never includes the secret. */
function serializeKey(key: {
  id: string;
  keyHint: string;
  name: string | null;
  projectId: string;
  scope: string;
  expireTime: Date | null;
  lastUseTime: Date | null;
  createTime: Date;
}) {
  return {
    id: key.id,
    name: key.name,
    hint: key.keyHint,
    project_id: key.projectId,
    // Now honest: the value is stored and enforced, so reporting it describes a
    // real restriction rather than advertising one that does not exist.
    scope: key.scope,
    expires_at: key.expireTime ? key.expireTime.toISOString() : null,
    last_used_at: key.lastUseTime ? key.lastUseTime.toISOString() : null,
    created_at: key.createTime.toISOString(),
  };
}

// GET /api/public/api-keys — list this project's keys (metadata only).
export async function GET(request: NextRequest) {
  // Enumerating a project's credentials is reconnaissance if an ingest key
  // leaks, so it is a management operation like minting one.
  const result = await requireApiKeyProject(request, { require: "admin" });
  if (!result.ok) {
    return result.response;
  }

  const keys = await prisma.accessKey.findMany({
    where: { projectId: result.auth.projectId },
    select: {
      id: true,
      keyHint: true,
      name: true,
      projectId: true,
      scope: true,
      expireTime: true,
      lastUseTime: true,
      createTime: true,
    },
    orderBy: { createTime: "desc" },
  });

  // Callers list before creating, to reuse an existing key rather than
  // accumulating a new one on every run.
  return NextResponse.json({ keys: keys.map(serializeKey) });
}

// POST /api/public/api-keys — mint a key for this project.
export async function POST(request: NextRequest) {
  // Without this, a leaked ingest key could mint an admin key and escalate.
  const result = await requireApiKeyProject(request, { require: "admin" });
  if (!result.ok) {
    return result.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return publicError("Request body must be JSON", 400);
  }

  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return publicError(parsed.error.issues[0].message, 400);
  }
  const { name, expires_in_days } = parsed.data;
  const scope = parsed.data.scope ?? "ingest";

  // A duplicate name is almost always a client that failed to check for an
  // existing key first; refuse rather than silently growing a pile of
  // identically-named credentials nobody can tell apart later.
  const existing = await prisma.accessKey.findFirst({
    where: { projectId: result.auth.projectId, name },
    select: { id: true },
  });
  if (existing) {
    return publicError(`An API key named '${name}' already exists in this project`, 409);
  }

  const secret = generateApiKey();
  const expireTime =
    expires_in_days === null || expires_in_days === undefined
      ? null
      : new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);

  const created = await prisma.accessKey.create({
    data: {
      id: crypto.randomUUID(),
      projectId: result.auth.projectId,
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
      lastUseTime: true,
      createTime: true,
    },
  });

  // `key` is returned exactly once, here. It is never recoverable afterwards —
  // only the hash is stored — so a caller that discards it must mint another.
  return NextResponse.json({ ...serializeKey(created), key: secret }, { status: 201 });
}
