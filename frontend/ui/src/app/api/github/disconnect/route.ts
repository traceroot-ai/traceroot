import { prisma } from "@traceroot/core";
import { requireAuth, successResponse } from "@/lib/auth-helpers";
import { GITHUB_INSTALLATION_ID_COOKIE } from "@traceroot/github";
import { NextResponse } from "next/server";

// POST /api/github/disconnect - Disconnect GitHub integration
export async function POST() {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  try {
    // Delete the GitHub connection
    await prisma.gitHubConnection.delete({
      where: { userId: user.id },
    });

    // Clear the installation ID cookie
    const response = NextResponse.json({ success: true });
    response.cookies.set(GITHUB_INSTALLATION_ID_COOKIE, "", {
      httpOnly: false,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    return response;
  } catch (error) {
    // If no connection exists, that's fine
    return successResponse({ success: true });
  }
}
