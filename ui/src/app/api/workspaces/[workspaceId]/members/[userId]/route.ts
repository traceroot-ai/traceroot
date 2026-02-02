import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const updateRoleSchema = z.object({
  role: z.enum(["VIEWER", "MEMBER", "ADMIN", "OWNER"]),
});

type RouteParams = { params: Promise<{ workspaceId: string; userId: string }> };

// PUT /api/workspaces/[workspaceId]/members/[userId] - Update member role (ADMIN+)
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, userId: targetUserId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
  if (membershipResult.error) return membershipResult.error;
  const { membership: callerMembership } = membershipResult;

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

  // Only OWNER can change to/from OWNER role
  if (newRole === "OWNER" || targetMembership.role === "OWNER") {
    if (callerMembership.role !== "OWNER") {
      return errorResponse("Only owners can change owner roles", 403);
    }
  }

  // Cannot demote yourself from OWNER if you're the last owner
  if (
    user.id === targetUserId &&
    targetMembership.role === "OWNER" &&
    newRole !== "OWNER"
  ) {
    const ownerCount = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: "OWNER",
      },
    });

    if (ownerCount <= 1) {
      return errorResponse(
        "Cannot demote the last owner. Transfer ownership first.",
        400
      );
    }
  }

  const updated = await prisma.workspaceMember.update({
    where: { id: targetMembership.id },
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
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, userId: targetUserId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
  if (membershipResult.error) return membershipResult.error;
  const { membership: callerMembership } = membershipResult;

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

  // Only OWNER can remove other owners
  if (targetMembership.role === "OWNER" && callerMembership.role !== "OWNER") {
    return errorResponse("Only owners can remove other owners", 403);
  }

  // Cannot remove yourself if you're the last owner
  if (user.id === targetUserId && targetMembership.role === "OWNER") {
    const ownerCount = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: "OWNER",
      },
    });

    if (ownerCount <= 1) {
      return errorResponse(
        "Cannot leave as the last owner. Transfer ownership first.",
        400
      );
    }
  }

  await prisma.workspaceMember.delete({
    where: { id: targetMembership.id },
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
