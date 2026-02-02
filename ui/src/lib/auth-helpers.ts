import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Role hierarchy (higher index = more permissions)
const ROLE_HIERARCHY = ["VIEWER", "MEMBER", "ADMIN"] as const;
export type Role = (typeof ROLE_HIERARCHY)[number];

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
  const session = await getServerSession(authOptions);
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
  workspaceId: string
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
    role: membership.role as Role,
  };
}

/**
 * Check if a role meets the minimum required role.
 */
export function hasMinRole(userRole: Role, minRole: Role): boolean {
  const userIndex = ROLE_HIERARCHY.indexOf(userRole);
  const minIndex = ROLE_HIERARCHY.indexOf(minRole);
  return userIndex >= minIndex;
}

/**
 * Require workspace membership with optional minimum role.
 * Returns membership info or error response.
 */
export async function requireWorkspaceMembership(
  userId: string,
  workspaceId: string,
  minRole?: Role
): Promise<
  { membership: WorkspaceMembership; error?: never } | { membership?: never; error: NextResponse }
> {
  const membership = await getWorkspaceMembership(userId, workspaceId);

  if (!membership) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this workspace" },
        { status: 403 }
      ),
    };
  }

  if (minRole && !hasMinRole(membership.role, minRole)) {
    return {
      error: NextResponse.json(
        { error: `Requires ${minRole} role or higher` },
        { status: 403 }
      ),
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
  minRole?: Role
): Promise<
  | { project: { id: string; workspaceId: string; name: string }; membership: WorkspaceMembership; error?: never }
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
 * Verify internal API secret for Python backend calls.
 */
export function verifyInternalSecret(request: Request): boolean {
  const secret = request.headers.get("X-Internal-Secret");
  const expectedSecret = process.env.INTERNAL_API_SECRET;

  if (!expectedSecret) {
    console.error("INTERNAL_API_SECRET not configured");
    return false;
  }

  return secret === expectedSecret;
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
