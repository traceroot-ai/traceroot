import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { generateApiKey, getKeyPrefix, hashApiKey } from "@/lib/api-keys";

const createAccessKeySchema = z.object({
  name: z.string().max(100, "Name too long").nullable().optional(),
  expire_time: z.string().datetime().nullable().optional(),
});

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/api-keys - List access keys
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const accessResult = await requireProjectAccess(user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const accessKeys = await prisma.accessKey.findMany({
    where: { projectId },
    select: {
      id: true,
      keyHint: true,
      name: true,
      expireTime: true,
      lastUseTime: true,
      createTime: true,
    },
    orderBy: { createTime: "desc" },
  });

  return successResponse({
    access_keys: accessKeys.map((k) => ({
      id: k.id,
      key_hint: k.keyHint,
      name: k.name,
      expire_time: k.expireTime,
      last_use_time: k.lastUseTime,
      create_time: k.createTime,
    })),
  });
}

// POST /api/projects/[projectId]/api-keys - Create a new access key (MEMBER+)
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const accessResult = await requireProjectAccess(user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Empty body is fine
    body = {};
  }

  const result = createAccessKeySchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name, expire_time } = result.data;

  // Generate new access key
  const accessKey = generateApiKey();
  const secretHash = hashApiKey(accessKey);
  const keyHint = getKeyPrefix(accessKey);
  const keyId = crypto.randomUUID();

  const savedKey = await prisma.accessKey.create({
    data: {
      id: keyId,
      projectId,
      secretHash,
      keyHint,
      name: name ?? null,
      expireTime: expire_time ? new Date(expire_time) : null,
    },
  });

  // Return the full access key only once - user must copy it now
  return NextResponse.json(
    {
      id: savedKey.id,
      key: accessKey, // Full key - only returned on creation!
      key_hint: savedKey.keyHint,
      name: savedKey.name,
      expire_time: savedKey.expireTime,
      create_time: savedKey.createTime,
    },
    { status: 201 },
  );
}
