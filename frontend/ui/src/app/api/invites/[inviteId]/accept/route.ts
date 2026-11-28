import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { prisma, getSeatLimit, canAddSeat, PlanType } from "@traceroot/core";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";
import { notifyWorkspaceMember } from "@/lib/signup/membership-webhook";
import { inviteEmailIsProven } from "@/lib/invite-identity";
import { notifyMembershipChange } from "@/lib/membership-notifications";

type RouteParams = { params: Promise<{ inviteId: string }> };

// POST /api/invites/[inviteId]/accept - Accept an invite
async function handlePOST(request: NextRequest, { params }: RouteParams) {
  const { inviteId } = await params;
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const reference = await prisma.invite.findUnique({
    where: { id: inviteId },
    select: { workspaceId: true },
  });
  if (!reference) return errorResponse("Invite not found", 404);
  const emailProven = await inviteEmailIsProven(user.id);

  const outcome = await prisma.$transaction(async (tx) => {
    // Use the same lock as invitation creation before reading seat occupancy.
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${reference.workspaceId} FOR UPDATE`;
    const invite = await tx.invite.findUnique({ where: { id: inviteId } });
    if (!invite) return { error: errorResponse("Invite not found", 404) };

    if (invite.email.toLowerCase() !== user.email?.toLowerCase()) {
      return { error: errorResponse("This invite is not for your email address", 403) };
    }
    if (!emailProven) {
      return {
        error: errorResponse(
          "Verify your email address with your sign-in provider, then accept this invite again.",
          403,
        ),
      };
    }

    const existingMembership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
    });
    if (existingMembership) {
      await tx.invite.deleteMany({ where: { id: inviteId } });
      return { error: errorResponse("You are already a member of this workspace", 409) };
    }

    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: invite.workspaceId },
      select: {
        id: true,
        name: true,
        billingPlan: true,
        _count: { select: { members: true, invites: true } },
      },
    });
    const plan = (workspace.billingPlan || PlanType.FREE) as PlanType;
    // This invite already reserves one seat and is consumed by the write below.
    const otherSeats = workspace._count.members + workspace._count.invites - 1;
    if (!canAddSeat(plan, otherSeats)) {
      return {
        error: errorResponse(
          `This workspace has reached its seat limit (${getSeatLimit(plan)}). ` +
            `Ask an admin to upgrade the plan or remove a member.`,
          403,
        ),
      };
    }

    const membership = await tx.workspaceMember.create({
      data: {
        id: crypto.randomUUID(),
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role,
      },
    });
    await tx.invite.delete({ where: { id: inviteId } });
    return { membership, workspace };
  });
  if (outcome.error) return outcome.error;
  const { membership, workspace } = outcome;
  void notifyWorkspaceMember({ userId: user.id, workspaceId: workspace.id, via: "invite" });
  await notifyMembershipChange({
    actorUserId: user.id,
    workspaceId: workspace.id,
    membershipId: membership.id,
    userId: user.id,
    role: membership.role,
    operation: "joined",
  });

  return successResponse({
    message: "Invite accepted",
    workspace: { id: workspace.id, name: workspace.name },
    role: membership.role,
  });
}
export const POST = withImpersonationPolicy(handlePOST);
