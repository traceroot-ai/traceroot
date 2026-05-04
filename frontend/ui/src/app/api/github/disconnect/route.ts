import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { errorResponse, requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import { GITHUB_INSTALLATION_ID_COOKIE } from "@traceroot/github";

// POST /api/github/disconnect?workspaceId=...&installationId=...
// Removes a single installation if installationId is given, otherwise removes
// all installations for the workspace. Requires workspace membership.
export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) {
    return errorResponse("workspaceId required", 400);
  }

  const memberCheck = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
  if (memberCheck.error) return memberCheck.error;

  const installationId = request.nextUrl.searchParams.get("installationId");
  await prisma.gitHubInstallation.deleteMany({
    where: {
      workspaceId,
      ...(installationId ? { installationId } : {}),
    },
  });

  const response = NextResponse.json({ success: true });
  response.cookies.set(GITHUB_INSTALLATION_ID_COOKIE, "", {
    httpOnly: false,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
