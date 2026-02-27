import { NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import { getInstallationToken } from "@traceroot/github";

export async function GET() {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const connection = await prisma.gitHubConnection.findUnique({
      where: { userId: user.id },
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
      expires_at,
    });
  } catch (error) {
    console.error("GitHub token error:", error);
    return NextResponse.json({ error: "Failed to get installation token" }, { status: 500 });
  }
}
