import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, PlanType } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const grantAccessSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  projectId: z.string().min(1, "projectId is required"),
  clientId: z.string().min(1, "clientId is required"),
});

// POST /api/internal/oauth-grant-access
//
// Called by the Python backend for every request an OAuth access token makes. The
// backend has already verified the token's signature, audience and scope offline;
// this answers the two things a signature cannot: is the grant still live (the
// user has not revoked the connection, the client has not been disabled), and does
// the user still belong to the project the token names. Answering per request is
// what makes revoking a connection, or removing someone from a project, take
// effect at once instead of when the token expires. Same response shape as
// user-project-access. A revoked grant is a 401, a lost membership a 403. Never log
// ids.
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
  const result = grantAccessSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }
  const { userId, projectId, clientId } = result.data;

  const [consent, client] = await Promise.all([
    prisma.oauthConsent.findFirst({
      where: { userId, clientId, referenceId: projectId },
      select: { id: true },
    }),
    prisma.oauthClient.findUnique({ where: { clientId }, select: { disabled: true } }),
  ]);
  if (!consent || !client || client.disabled) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: { id: true, workspaceId: true, workspace: { select: { billingPlan: true } } },
  });
  if (!project) {
    return NextResponse.json({ hasAccess: false }, { status: 403 });
  }
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) {
    return NextResponse.json({ hasAccess: false }, { status: 403 });
  }

  return NextResponse.json({
    valid: true,
    hasAccess: true,
    userId,
    role: membership.role,
    workspaceId: project.workspaceId,
    billingPlan: project.workspace?.billingPlan || PlanType.FREE,
    projectId: project.id,
  });
}
