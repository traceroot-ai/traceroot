import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { listWorkspaceModels } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/llm-models — the models a detector (or the
// assistant) in this workspace can run on: system providers the deployment
// holds keys for, plus the workspace's BYOK providers and their models.
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(authResult.user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  return successResponse(await listWorkspaceModels(workspaceId));
}
export const GET = withImpersonationPolicy(handleGET);
