import type { NextResponse } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, requireProjectAccess } from "@/lib/auth-helpers";

/**
 * Revoke one of a project's access keys for an already-authenticated user.
 *
 * The dashboard's delete, shared with the command line's revoke on a user
 * credential (`/api/internal/user-revoke-project-key`), so the two cannot
 * drift: ADMIN only, and the key is looked up within `projectId`, so a key in
 * another project is "not found" and never deleted.
 */
export async function revokeProjectAccessKey(
  userId: string,
  projectId: string,
  keyId: string,
): Promise<{ error?: NextResponse }> {
  const accessResult = await requireProjectAccess(userId, projectId, Role.ADMIN);
  if (accessResult.error) return { error: accessResult.error };

  // Check access key exists and belongs to this project
  const accessKey = await prisma.accessKey.findFirst({
    where: {
      id: keyId,
      projectId,
    },
  });

  if (!accessKey) {
    return { error: errorResponse("Access key not found", 404) };
  }

  await prisma.accessKey.delete({
    where: { id: keyId },
  });

  return {};
}
