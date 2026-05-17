import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  errorResponse,
  requireAuth,
  requireWorkspaceMembership,
  successResponse,
} from "@/lib/auth-helpers";

// GET /api/github/status?workspaceId=...
// Returns the workspace's GitHub App installations.
export async function GET(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) {
    return errorResponse("workspaceId required", 400);
  }

  const memberCheck = await requireWorkspaceMembership(user.id, workspaceId);
  if (memberCheck.error) return memberCheck.error;

  const installations = await prisma.gitHubInstallation.findMany({
    where: { workspaceId },
    orderBy: { createTime: "asc" },
    select: { installationId: true, accountLogin: true, createTime: true },
  });

  return successResponse({
    connected: installations.length > 0,
    installations: installations.map((i) => ({
      installationId: i.installationId,
      accountLogin: i.accountLogin,
    })),
  });
}
