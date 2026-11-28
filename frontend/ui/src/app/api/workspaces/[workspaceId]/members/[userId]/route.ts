import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role, RoleSchema } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

import { notifyMembershipChange } from "@/lib/membership-notifications";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";

const updateRoleSchema = z.object({
  role: RoleSchema,
});

type RouteParams = { params: Promise<{ workspaceId: string; userId: string }> };

// PUT /api/workspaces/[workspaceId]/members/[userId] - Update member role (ADMIN+)
async function handlePUT(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, userId: targetUserId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = updateRoleSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { role: newRole } = result.data;

  // Get target membership
  const targetMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId: targetUserId,
      },
    },
  });

  if (!targetMembership) {
    return errorResponse("Member not found", 404);
  }

  // Cannot demote yourself from ADMIN if you're the last admin
  if (user.id === targetUserId && targetMembership.role === Role.ADMIN && newRole !== Role.ADMIN) {
    const adminCount = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: Role.ADMIN,
      },
    });

    if (adminCount <= 1) {
      return errorResponse("Cannot demote the last admin. Promote another member first.", 400);
    }
  }

  let updated;
  try {
    updated = await prisma.workspaceMember.update({
      where: { id: targetMembership.id, role: targetMembership.role },
      data: {
        role: newRole,
        updateTime: new Date(),
      },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
    });
  } catch (error) {
    if (isPrismaKnownError(error, "P2025")) {
      return errorResponse("Membership changed. Refresh and try again.", 409);
    }
    throw error;
  }

  if (targetMembership.role !== newRole) {
    await notifyMembershipChange({
      actorUserId: user.id,
      workspaceId,
      membershipId: updated.id,
      userId: targetUserId,
      role: newRole,
      previousRole: targetMembership.role,
      operation: "role_changed",
    });
  }

  return successResponse({
    id: updated.id,
    user_id: updated.user.id,
    email: updated.user.email,
    name: updated.user.name,
    role: updated.role,
    update_time: updated.updateTime,
  });
}

// DELETE /api/workspaces/[workspaceId]/members/[userId] - Remove member (ADMIN+)
async function handleDELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, userId: targetUserId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  // Get target membership
  const targetMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId: targetUserId,
      },
    },
  });

  if (!targetMembership) {
    return errorResponse("Member not found", 404);
  }

  // Cannot remove yourself if you're the last admin
  if (user.id === targetUserId && targetMembership.role === Role.ADMIN) {
    const adminCount = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: Role.ADMIN,
      },
    });

    if (adminCount <= 1) {
      return errorResponse("Cannot leave as the last admin. Promote another member first.", 400);
    }
  }

  let removed;
  try {
    removed = await prisma.workspaceMember.delete({
      where: { id: targetMembership.id },
    });
  } catch (error) {
    if (isPrismaKnownError(error, "P2025")) {
      return errorResponse("Member not found", 404);
    }
    throw error;
  }

  await notifyMembershipChange({
    actorUserId: user.id,
    workspaceId,
    membershipId: targetMembership.id,
    userId: targetUserId,
    role: removed.role,
    operation: "removed",
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
export const PUT = withImpersonationPolicy(handlePUT);
export const DELETE = withImpersonationPolicy(handleDELETE);
