import type { NextResponse } from "next/server";
import { prisma, Role } from "@traceroot/core";
import { errorResponse, requireProjectAccess } from "@/lib/auth-helpers";

/**
 * Revoke one of a project's access keys for an already-authenticated user.
 *
 * The dashboard's delete, shared with the command line's revoke on a user
 * credential (`/api/internal/user-revoke-project-key`), so the two cannot
 * drift: ADMIN only, and the key is deleted only within `projectId`, so a key
 * in another project is "not found" and never deleted.
 */
export async function revokeProjectAccessKey(
  userId: string,
  projectId: string,
  keyId: string,
): Promise<{ error?: NextResponse }> {
  const accessResult = await requireProjectAccess(userId, projectId, Role.ADMIN);
  if (accessResult.error) return { error: accessResult.error };

  // One statement scoped to the project, so the check and the delete cannot be
  // separated: a key another revoke removed in between is "not found", not a
  // delete that throws.
  const deleted = await prisma.accessKey.deleteMany({
    where: {
      id: keyId,
      projectId,
    },
  });

  if (deleted.count === 0) {
    return { error: errorResponse("Access key not found", 404) };
  }

  return {};
}
