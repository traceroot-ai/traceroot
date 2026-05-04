import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership, verifyInternalSecret } from "@/lib/auth-helpers";
import { getInstallationToken } from "@traceroot/github";

/**
 * Issue a short-lived GitHub App installation access token for a workspace's
 * GitHub install. Repo-scoped: ?repo=owner/name selects the matching installation
 * (multi-org workspaces have multiple installations, one per org).
 *
 * Two auth paths:
 *   - Internal (agent tools): X-Internal-Secret + x-workspace-id header.
 *   - Browser/session: workspaceId query param + workspace membership.
 */
export async function GET(request: NextRequest) {
  try {
    let workspaceId: string | undefined;

    const internalWorkspaceId = request.headers.get("x-workspace-id");
    if (internalWorkspaceId && verifyInternalSecret(request)) {
      workspaceId = internalWorkspaceId;
    } else {
      const authResult = await requireAuth();
      if (authResult.error) return authResult.error;
      workspaceId = request.nextUrl.searchParams.get("workspaceId") || undefined;
      if (!workspaceId) {
        return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
      }
      const memberCheck = await requireWorkspaceMembership(authResult.user.id, workspaceId);
      if (memberCheck.error) return memberCheck.error;
    }

    const repo = request.nextUrl.searchParams.get("repo");
    const installations = await prisma.gitHubInstallation.findMany({
      where: { workspaceId },
    });

    if (installations.length === 0) {
      return NextResponse.json({ error: "No GitHub App installation found" }, { status: 404 });
    }

    // If a repo is provided, the install whose accountLogin matches the repo
    // owner is the only valid one — silently falling back to the first install
    // would mint a token for the wrong org in multi-installation workspaces.
    // No repo provided → caller doesn't care which install (e.g. status check),
    // so we hand back the first one.
    let chosen = installations[0];
    if (repo) {
      const repoOwner = repo.split("/")[0]?.toLowerCase();
      const match = repoOwner
        ? installations.find((i) => i.accountLogin.toLowerCase() === repoOwner)
        : undefined;
      if (!match) {
        return NextResponse.json(
          { error: "No GitHub App installation found for repo owner" },
          { status: 404 },
        );
      }
      chosen = match;
    }

    const { token, expires_at } = await getInstallationToken(
      chosen.installationId,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
    );

    return NextResponse.json({
      token,
      installation_id: chosen.installationId,
      github_username: chosen.accountLogin,
      expires_at,
    });
  } catch (error) {
    console.error("GitHub token error:", error);
    return NextResponse.json({ error: "Failed to get installation token" }, { status: 500 });
  }
}
