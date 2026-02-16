import { NextRequest } from "next/server";
import { prisma, getSeatLimit, canAddSeat, type PlanType } from "@traceroot/core";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ inviteId: string }> };

// POST /api/invites/[inviteId]/accept - Accept an invite
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { inviteId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  // Find the invite with workspace details for seat check
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          billingPlan: true,
          _count: {
            select: { members: true },
          },
        },
      },
    },
  });

  if (!invite) {
    return errorResponse("Invite not found", 404);
  }

  // Check if the invite is for this user's email
  if (invite.email.toLowerCase() !== user.email?.toLowerCase()) {
    return errorResponse("This invite is not for your email address", 403);
  }

  // Check if user is already a member
  const existingMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: invite.workspaceId,
        userId: user.id,
      },
    },
  });

  if (existingMembership) {
    // Delete the invite since user is already a member
    await prisma.invite.delete({
      where: { id: inviteId },
    });
    return errorResponse("You are already a member of this workspace", 409);
  }

  // Check seat limit before accepting invite
  // (Plan may have been downgraded since invite was sent)
  const plan = (invite.workspace.billingPlan || "free") as PlanType;
  const currentMembers = invite.workspace._count.members;
  const seatLimit = getSeatLimit(plan);

  if (!canAddSeat(plan, currentMembers)) {
    return errorResponse(
      `This workspace has reached its seat limit (${seatLimit}). ` +
        `Ask an admin to upgrade the plan or remove a member.`,
      403,
    );
  }

  // Accept the invite: create membership and delete invite
  const membershipId = crypto.randomUUID();

  await prisma.$transaction([
    prisma.workspaceMember.create({
      data: {
        id: membershipId,
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role,
      },
    }),
    prisma.invite.delete({
      where: { id: inviteId },
    }),
  ]);

  return successResponse({
    message: "Invite accepted",
    workspace: {
      id: invite.workspace.id,
      name: invite.workspace.name,
    },
    role: invite.role,
  });
}
