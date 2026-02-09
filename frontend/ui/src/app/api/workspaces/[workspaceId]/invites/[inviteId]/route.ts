import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership, errorResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ workspaceId: string; inviteId: string }> };

// DELETE /api/workspaces/[workspaceId]/invites/[inviteId] - Cancel invite (ADMIN+)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, inviteId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
  if (membershipResult.error) return membershipResult.error;

  // Check invite exists and belongs to this workspace
  const invite = await prisma.invite.findFirst({
    where: {
      id: inviteId,
      workspaceId,
    },
  });

  if (!invite) {
    return errorResponse("Invite not found", 404);
  }

  await prisma.invite.delete({
    where: { id: inviteId },
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
