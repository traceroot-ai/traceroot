import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth, verifyInternalSecret } from "@/lib/auth-helpers";
import { getInstallationToken } from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    // Support both session auth (browser) and internal x-user-id (agent service)
    let userId: string;
    const internalUserId = request.headers.get("x-user-id");

    if (internalUserId && verifyInternalSecret(request)) {
      userId = internalUserId;
    } else {
      const authResult = await requireAuth();
      if (authResult.error) return authResult.error;
      userId = authResult.user.id;
    }

    const connection = await prisma.gitHubConnection.findUnique({
      where: { userId },
    });

    if (!connection || !connection.installationId) {
      return NextResponse.json({ error: "No GitHub App installation found" }, { status: 404 });
    }

    const { token, expires_at } = await getInstallationToken(
      connection.installationId,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );

    return NextResponse.json({
      token,
      installation_id: connection.installationId,
      github_username: connection.githubUsername,
      expires_at,
    });
  } catch (error) {
    console.error("GitHub token error:", error);
    return NextResponse.json({ error: "Failed to get installation token" }, { status: 500 });
  }
}
