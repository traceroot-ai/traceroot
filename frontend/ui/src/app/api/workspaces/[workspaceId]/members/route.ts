import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role, RoleSchema, getSeatLimit, canAddSeat, PlanType } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const addMemberSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  role: RoleSchema,
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
    role: m.role,
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

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
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
    // Self-healing for legacy data: routes prior to this fix could create a
    // membership without deleting the matching invite (mirrors accept-route's
    // cleanup on its own already-a-member branch). deleteMany is a no-op
    // (not a throw) when no row matches, so a concurrent request that
    // already cleaned up the same stale invite can't turn this best-effort
    // cleanup into an unhandled 500.
    await prisma.invite.deleteMany({
      where: { email: targetUser.email.toLowerCase(), workspaceId },
    });

    return errorResponse("User is already a member of this workspace", 409);
  }

  // Check seat limit before adding member. Counts members + pending invites
  // (mirrors invite-create) since an outstanding invite can still be
  // accepted later; see the accept route for why it counts members only.
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      _count: {
        select: {
          members: true,
          invites: true,
        },
      },
    },
  });

  if (!workspace) {
    return errorResponse("Workspace not found", 404);
  }

  // A pending invite for this user's email is about to be superseded by the
  // direct membership created below, so it must not be double-counted
  // against the seat limit (mirrors invite-accept's own transaction).
  const pendingInvite = await prisma.invite.findUnique({
    where: {
      email_workspaceId: {
        email: targetUser.email.toLowerCase(),
        workspaceId,
      },
    },
  });

  const plan = (workspace.billingPlan || PlanType.FREE) as PlanType;
  const currentSeats =
    workspace._count.members + workspace._count.invites - (pendingInvite ? 1 : 0);
  const seatLimit = getSeatLimit(plan);

  if (!canAddSeat(plan, currentSeats)) {
    return errorResponse(
      `Your ${plan} plan is limited to ${seatLimit} seat${seatLimit === 1 ? "" : "s"}. ` +
        `Upgrade your plan to add more members.`,
      403,
    );
  }

  const membershipId = crypto.randomUUID();

  const createMembership = prisma.workspaceMember.create({
    data: {
      id: membershipId,
      workspaceId,
      userId,
      role,
    },
  });

  const [membership] = pendingInvite
    ? await prisma.$transaction([
        createMembership,
        prisma.invite.delete({ where: { id: pendingInvite.id } }),
      ])
    : await prisma.$transaction([createMembership]);

  return NextResponse.json(
    {
      id: membership.id,
      user_id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: membership.role,
      create_time: membership.createTime,
    },
    { status: 201 },
  );
}
