import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role, RoleSchema, getSeatLimit, canAddSeat, type PlanType } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { sendInviteEmail } from "@/lib/email";

const createInviteSchema = z.object({
  email: z.string().email("Invalid email"),
  role: RoleSchema,
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/invites - List pending invites
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  const invites = await prisma.invite.findMany({
    where: { workspaceId },
    include: {
      invitedBy: {
        select: { id: true, email: true, name: true },
      },
    },
    orderBy: { createTime: "desc" },
  });

  return successResponse({
    invites: invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invited_by: inv.invitedBy
        ? {
            id: inv.invitedBy.id,
            email: inv.invitedBy.email,
            name: inv.invitedBy.name,
          }
        : null,
      create_time: inv.createTime,
    })),
  });
}

// POST /api/workspaces/[workspaceId]/invites - Create invite (ADMIN+)
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

  const result = createInviteSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { email, role } = result.data;
  const normalizedEmail = email.toLowerCase();

  // Check if user is already a member
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    const existingMembership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: existingUser.id,
        },
      },
    });

    if (existingMembership) {
      return errorResponse("User is already a member of this workspace", 409);
    }
  }

  // Check if invite already exists
  const existingInvite = await prisma.invite.findUnique({
    where: {
      email_workspaceId: {
        email: normalizedEmail,
        workspaceId,
      },
    },
  });

  if (existingInvite) {
    return errorResponse("An invite has already been sent to this email", 409);
  }

  // Check seat limit before creating invite
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

  const plan = (workspace.billingPlan || "free") as PlanType;
  const currentSeats = workspace._count.members + workspace._count.invites;
  const seatLimit = getSeatLimit(plan);

  if (!canAddSeat(plan, currentSeats)) {
    return errorResponse(
      `Your ${plan} plan is limited to ${seatLimit} seat${seatLimit === 1 ? "" : "s"}. ` +
        `Upgrade your plan to invite more members.`,
      403,
    );
  }

  const inviteId = crypto.randomUUID();

  const invite = await prisma.invite.create({
    data: {
      id: inviteId,
      email: normalizedEmail,
      workspaceId,
      role,
      invitedByUserId: user.id,
    },
    include: {
      invitedBy: {
        select: { id: true, email: true, name: true },
      },
      workspace: {
        select: { name: true },
      },
    },
  });

  // Send invitation email (don't fail request if email fails)
  try {
    await sendInviteEmail({
      to: normalizedEmail,
      inviterName: user.name || user.email || "A team member",
      inviterEmail: user.email || "",
      workspaceName: invite.workspace.name,
      inviteId: invite.id,
      role,
    });
  } catch (error) {
    console.error("[Invite] Failed to send invitation email:", error);
  }

  return NextResponse.json(
    {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      invited_by: invite.invitedBy
        ? {
            id: invite.invitedBy.id,
            email: invite.invitedBy.email,
            name: invite.invitedBy.name,
          }
        : null,
      create_time: invite.createTime,
    },
    { status: 201 },
  );
}
