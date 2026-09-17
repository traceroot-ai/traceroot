import { createHash, timingSafeEqual } from "crypto";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { prisma, type Role, hasMinRole } from "@traceroot/core";
import { env } from "@/env";
export type { Role } from "@traceroot/core";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  name: string | null;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: Role;
}

/**
 * Get the current authenticated user from the session.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session?.user?.id) {
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
  };
}

/**
 * Require authentication. Returns the user or a 401 response.
 */
export async function requireAuth(): Promise<
  { user: AuthenticatedUser; error?: never } | { user?: never; error: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { user };
}

/**
 * Get user's membership in a workspace.
 * Returns null if user is not a member.
 */
export async function getWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembership | null> {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
  });

  if (!membership) {
    return null;
  }

  return {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    role: membership.role,
  };
}

/**
 * Require workspace membership with optional minimum role.
 * Returns membership info or error response.
 */
export async function requireWorkspaceMembership(
  userId: string,
  workspaceId: string,
  minRole?: Role,
): Promise<
  { membership: WorkspaceMembership; error?: never } | { membership?: never; error: NextResponse }
> {
  const membership = await getWorkspaceMembership(userId, workspaceId);

  if (!membership) {
    return {
      error: NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 }),
    };
  }

  if (minRole && !hasMinRole(membership.role, minRole)) {
    return {
      error: NextResponse.json({ error: `Requires ${minRole} role or higher` }, { status: 403 }),
    };
  }

  return { membership };
}

/**
 * Require workspace access via project.
 * First checks if project exists and belongs to the workspace, then checks membership.
 */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
  minRole?: Role,
): Promise<
  | {
      project: { id: string; workspaceId: string; name: string };
      membership: WorkspaceMembership;
      error?: never;
    }
  | { project?: never; membership?: never; error: NextResponse }
> {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: { id: true, workspaceId: true, name: true },
  });

  if (!project) {
    return {
      error: NextResponse.json({ error: "Project not found" }, { status: 404 }),
    };
  }

  const membershipResult = await requireWorkspaceMembership(userId, project.workspaceId, minRole);
  if (membershipResult.error) {
    return membershipResult;
  }

  return { project, membership: membershipResult.membership };
}

/**
 * Verify the internal API secret on server-to-server calls.
 *
 * Two credentials are accepted, as on the REST side: the platform secret
 * (INTERNAL_API_SECRET: Python backend, worker) and the agent service's own
 * (INTERNAL_API_SECRET_AGENT), which it sends on every internal call so it
 * never has to hold the platform one. Same privilege either way; the split is
 * what lets the agent secret be rotated alone. The agent secret is optional
 * here — blank means only the platform secret is accepted.
 *
 * Compared in constant time (crypto.timingSafeEqual) so response timing cannot
 * be used to recover a secret byte-by-byte. Both sides are hashed first so
 * the compared buffers always have equal length — timingSafeEqual throws on a
 * length mismatch, and any length-dependent early exit would leak the secret's
 * length. Fails closed on a missing header or a blank configured secret (env
 * validation already rejects a blank platform secret at boot; guarded here anyway).
 */
export function verifyInternalSecret(request: Request): boolean {
  const provided = request.headers.get("X-Internal-Secret");
  if (!provided) {
    return false;
  }
  return [env.INTERNAL_API_SECRET, env.INTERNAL_API_SECRET_AGENT].some(
    (expected) => !!expected && digestsMatch(provided, expected),
  );
}

function digestsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

/**
 * Helper to create error responses.
 */
export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Helper to create success responses.
 */
export function successResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
