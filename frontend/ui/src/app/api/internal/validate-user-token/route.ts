import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, PlanType } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { resolveSessionFromToken } from "@/lib/internal-session";

const validateUserTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  projectId: z.string().optional(),
});

// POST /api/internal/validate-user-token
// Internal endpoint for Python backend to validate a user's session token (the CLI's credential)
export async function POST(request: NextRequest) {
  // Verify internal secret
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ valid: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ valid: false, error: "Invalid JSON" }, { status: 400 });
  }

  const result = validateUserTokenSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { valid: false, error: result.error.issues[0].message },
      { status: 400 },
    );
  }

  const { token, projectId } = result.data;

  const session = await resolveSessionFromToken(token);

  if (!session?.user?.id) {
    return NextResponse.json({ valid: false, error: "invalid or expired token" }, { status: 401 });
  }

  const { user } = session;

  // Account-scope: no project requested, so a live session is sufficient (e.g. list_workspaces).
  if (!projectId) {
    return NextResponse.json({ valid: true, userId: user.id, email: user.email });
  }

  // Project-scoped: `valid` stays true (the token is a real live session) even when the
  // session has no access to this project — that distinction is carried by `hasAccess`.
  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: {
      id: true,
      workspaceId: true,
      workspace: { select: { billingPlan: true } },
    },
  });

  if (!project) {
    return NextResponse.json({ valid: true, hasAccess: false }, { status: 403 });
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: project.workspaceId,
        userId: user.id,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    return NextResponse.json({ valid: true, hasAccess: false }, { status: 403 });
  }

  return NextResponse.json({
    valid: true,
    userId: user.id,
    role: membership.role,
    workspaceId: project.workspaceId,
    billingPlan: project.workspace?.billingPlan || PlanType.FREE,
    projectId: project.id,
  });
}
