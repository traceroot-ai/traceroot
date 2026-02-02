import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const updateAccessKeySchema = z.object({
  name: z.string().max(100, "Name too long").nullable(),
});

type RouteParams = { params: Promise<{ projectId: string; keyId: string }> };

// PATCH /api/projects/[projectId]/api-keys/[keyId] - Update access key name (MEMBER+)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { projectId, keyId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const accessResult = await requireProjectAccess(user.id, projectId, "MEMBER");
  if (accessResult.error) return accessResult.error;

  // Check access key exists and belongs to this project
  const existingKey = await prisma.accessKey.findFirst({
    where: {
      id: keyId,
      projectId,
    },
  });

  if (!existingKey) {
    return errorResponse("Access key not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = updateAccessKeySchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name } = result.data;

  const accessKey = await prisma.accessKey.update({
    where: { id: keyId },
    data: {
      name,
    },
  });

  return successResponse({
    id: accessKey.id,
    key_hint: accessKey.keyHint,
    name: accessKey.name,
    expire_time: accessKey.expireTime,
    last_use_time: accessKey.lastUseTime,
    create_time: accessKey.createTime,
  });
}

// DELETE /api/projects/[projectId]/api-keys/[keyId] - Delete an access key (ADMIN+)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { projectId, keyId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const accessResult = await requireProjectAccess(user.id, projectId, "ADMIN");
  if (accessResult.error) return accessResult.error;

  // Check access key exists and belongs to this project
  const accessKey = await prisma.accessKey.findFirst({
    where: {
      id: keyId,
      projectId,
    },
  });

  if (!accessKey) {
    return errorResponse("Access key not found", 404);
  }

  await prisma.accessKey.delete({
    where: { id: keyId },
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
