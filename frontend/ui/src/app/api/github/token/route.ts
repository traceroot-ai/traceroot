import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth, verifyInternalSecret } from "@/lib/auth-helpers";
import { getInstallationToken } from "@traceroot/github";

/**
 * Look up the correct GitHub App installation for a given repo owner.
 * Uses the user's OAuth token to query GET /user/installations and match
 * by account login. This handles personal, org, and multi-org installations.
 */
async function findInstallationForRepo(
  accessToken: string,
  appId: string,
  repoOwner: string,
): Promise<string | null> {
  const res = await fetch("https://api.github.com/user/installations", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Traceroot",
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const installation = data.installations?.find(
    (inst: { app_id: number; account: { login: string } }) =>
      String(inst.app_id) === appId && inst.account.login.toLowerCase() === repoOwner.toLowerCase(),
  );

  return installation ? String(installation.id) : null;
}

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

    if (!connection) {
      return NextResponse.json({ error: "No GitHub connection found" }, { status: 404 });
    }

    // If a repo is specified, dynamically find the right installation
    const repo = request.nextUrl.searchParams.get("repo");
    let installationId = connection.installationId;

    if (repo) {
      const repoOwner = repo.split("/")[0];
      if (repoOwner && connection.accessToken) {
        const resolved = await findInstallationForRepo(
          connection.accessToken,
          env.GITHUB_APP_ID,
          repoOwner,
        );
        if (resolved) {
          installationId = resolved;
        }
      }
    }

    if (!installationId) {
      return NextResponse.json({ error: "No GitHub App installation found" }, { status: 404 });
    }

    const { token, expires_at } = await getInstallationToken(
      installationId,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );

    return NextResponse.json({
      token,
      installation_id: installationId,
      github_username: connection.githubUsername,
      expires_at,
    });
  } catch (error) {
    console.error("GitHub token error:", error);
    return NextResponse.json({ error: "Failed to get installation token" }, { status: 500 });
  }
}
