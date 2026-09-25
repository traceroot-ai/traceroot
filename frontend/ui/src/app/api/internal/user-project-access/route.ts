import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, PlanType } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const userProjectAccessSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  projectId: z.string().min(1, "projectId is required"),
});

// POST /api/internal/user-project-access
//
// Resolves a user's access + role + billing plan for one project, given a
// userId the caller has ALREADY authenticated. Used by the Python backend on
// the CLI JWT path: it verifies the access JWT offline (so identity is
// established by signature, not a session lookup) and then calls this to fill in
// the project-scoped fields a JWT doesn't carry. Unlike validate-user-token this
// does NOT validate a session token — trust is the X-Internal-Secret plus the
// backend's verified JWT. It reuses the same project + membership queries as
// validate-user-token's project-scope branch. Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = userProjectAccessSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { userId, projectId } = result.data;

  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: {
      id: true,
      workspaceId: true,
      workspace: { select: { billingPlan: true } },
    },
  });

  if (!project) {
    return NextResponse.json({ hasAccess: false }, { status: 403 });
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: project.workspaceId,
        userId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    return NextResponse.json({ hasAccess: false }, { status: 403 });
  }

  return NextResponse.json({
    // `valid` mirrors the other internal auth routes so the backend's shared
    // response handler treats a 200 as success.
    valid: true,
    hasAccess: true,
    userId,
    role: membership.role,
    workspaceId: project.workspaceId,
    billingPlan: project.workspace?.billingPlan || PlanType.FREE,
    projectId: project.id,
  });
}
