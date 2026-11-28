import { NextRequest, NextResponse } from "next/server";
import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { z } from "zod";
import {
  errorResponse,
  requireAuth,
  requireProjectAccess,
  successResponse,
} from "@/lib/auth-helpers";
import { getRequestSession } from "@/lib/request-session";
import { prisma } from "@traceroot/core";
import { readProjectSelection, saveProjectSelection } from "@/lib/oauth/project-selection";
import { isDemoWorkspace } from "@/lib/demo-workspace";

const bodySchema = z.object({ projectId: z.string().min(1) });

// POST /api/oauth/select-project
//
// Records which project the signed-in user chose for the assistant they are
// connecting. The user must belong to it; the demo workspace is not offered.
async function handlePOST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const session = await getRequestSession();
  if (!session?.session?.id) return errorResponse("Unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);

  const access = await requireProjectAccess(authResult.user.id, parsed.data.projectId);
  if (access.error) return access.error;
  if (isDemoWorkspace(access.project.workspaceId)) {
    return errorResponse("The demo workspace cannot be connected", 400);
  }

  await saveProjectSelection(session.session.id, access.project.id);
  return successResponse({ projectId: access.project.id, projectName: access.project.name });
}

// GET /api/oauth/select-project
//
// The project currently chosen for this session, with the names the consent
// page shows, or null when none is on record.
async function handleGET() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const session = await getRequestSession();
  if (!session?.session?.id) return errorResponse("Unauthorized", 401);

  const projectId = await readProjectSelection(session.session.id);
  if (!projectId) return NextResponse.json({ selection: null });

  const access = await requireProjectAccess(authResult.user.id, projectId);
  if (access.error) return NextResponse.json({ selection: null });
  const workspace = await prisma.workspace.findUnique({
    where: { id: access.project.workspaceId },
    select: { name: true },
  });
  return NextResponse.json({
    selection: {
      projectId: access.project.id,
      projectName: access.project.name,
      workspaceName: workspace?.name ?? null,
    },
  });
}

export const POST = withImpersonationPolicy(handlePOST);

export const GET = withImpersonationPolicy(handleGET);
