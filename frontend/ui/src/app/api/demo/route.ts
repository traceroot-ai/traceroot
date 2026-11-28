import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { prisma, Role } from "@traceroot/core";
import { requireAuth, errorResponse, successResponse } from "@/lib/auth-helpers";
import { demoWorkspaceId, ensureDemoMembership } from "@/lib/demo-workspace";

async function configuredDemo() {
  const workspaceId = demoWorkspaceId();
  if (!workspaceId) return null;
  const project = await prisma.project.findFirst({
    where: { workspaceId, deleteTime: null },
    orderBy: { createTime: "asc" },
    select: { id: true },
  });
  return { workspaceId, projectId: project?.id ?? null };
}

async function handleGET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const demo = await configuredDemo();
  if (!demo) return successResponse({ available: false, joined: false, canLeave: false });
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: demo.workspaceId, userId: auth.user.id } },
    select: { role: true },
  });
  return successResponse({
    available: demo.projectId !== null,
    joined: membership !== null,
    canLeave: membership?.role === Role.VIEWER,
  });
}

async function handlePOST() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const demo = await configuredDemo();
  if (!demo?.projectId) return errorResponse("The demo is not available on this deployment", 404);
  try {
    await ensureDemoMembership(auth.user.id);
  } catch (error) {
    console.error("[demo] could not join", auth.user.id, error);
    return errorResponse("Could not join the demo. Please try again.", 500);
  }
  return successResponse({ projectId: demo.projectId });
}

async function handleDELETE() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const workspaceId = demoWorkspaceId();
  if (!workspaceId) return errorResponse("The demo is not available on this deployment", 404);
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.user.id } },
    select: { role: true },
  });
  if (membership && membership.role !== Role.VIEWER)
    return errorResponse("Only demo visitors can leave through this page", 403);
  try {
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId, userId: auth.user.id, role: Role.VIEWER },
    });
  } catch (error) {
    console.error("[demo] could not leave", auth.user.id, error);
    return errorResponse("Could not leave the demo. Please try again.", 500);
  }
  return successResponse({ left: true });
}

export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
export const DELETE = withImpersonationPolicy(handleDELETE);
