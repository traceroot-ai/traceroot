import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
  Role,
} from "@/lib/auth-helpers";

const addMemberSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  role: z.enum(["VIEWER", "MEMBER", "ADMIN"]),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/members - List workspace members
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId);
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
    role: m.role as Role,
    create_time: m.createTime,
  }));

  return successResponse({ members });
}

// POST /api/workspaces/[workspaceId]/members - Add a member (ADMIN+)
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = addMemberSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { userId, role } = result.data;

  // Check if user exists
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });

  if (!targetUser) {
    return errorResponse("User not found", 404);
  }

  // Check if already a member
  const existingMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
  });

  if (existingMembership) {
    return errorResponse("User is already a member of this workspace", 409);
  }

  const membershipId = crypto.randomUUID();

  const membership = await prisma.workspaceMember.create({
    data: {
      id: membershipId,
      workspaceId,
      userId,
      role,
    },
  });

  return NextResponse.json(
    {
      id: membership.id,
      user_id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: membership.role,
      create_time: membership.createTime,
    },
    { status: 201 }
  );
}
