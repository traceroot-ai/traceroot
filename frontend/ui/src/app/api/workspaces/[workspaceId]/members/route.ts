import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { isDemoWorkspace } from "@/lib/demo-workspace";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/members - List workspace members
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  // Every user is a member of the demo workspace, so its member list holds the
  // email of every user. Only its admins can read it.
  const membershipResult = await requireWorkspaceMembership(
    user.id,
    workspaceId,
    isDemoWorkspace(workspaceId) ? Role.ADMIN : undefined,
  );
  if (membershipResult.error) return membershipResult.error;

  const memberships = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
    orderBy: [{ role: "asc" }, { createTime: "asc" }],
  });

  const members = memberships.map((m) => ({
    id: m.id,
    user_id: m.user.id,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    create_time: m.createTime,
  }));

  return successResponse({ members });
}

// Memberships are created only when the invited account accepts its invite.
async function handlePOST(_request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const access = await requireWorkspaceMembership(authResult.user.id, workspaceId, Role.ADMIN);
  if (access.error) return access.error;

  const response = errorResponse("Send an invitation to add a workspace member.", 405);
  response.headers.set("Allow", "GET");
  return response;
}
export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
