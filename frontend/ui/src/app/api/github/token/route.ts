import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma, Role } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership, verifyInternalSecret } from "@/lib/auth-helpers";
import { isDemoViewer, DEMO_VIEWER_FORBIDDEN } from "@/lib/demo-workspace";
import { getInstallationToken, type InstallationTokenScope } from "@traceroot/github";

/** Access the agent needs: read code, pull requests and repository metadata. */
const AGENT_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  metadata: "read",
} as const;

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Issue a short-lived GitHub App installation access token for a workspace's
 * GitHub install. Repo-scoped: ?repo=owner/name selects the matching installation
 * (multi-org workspaces have multiple installations, one per org).
 *
 * Two auth paths:
 *   - Internal (agent tools): X-Internal-Secret + x-workspace-id header.
 *   - Browser/session: workspaceId query param + MEMBER role or higher.
 */
async function handleGET(request: NextRequest) {
  try {
    let workspaceId: string | undefined;
    let isInternal = false;

    const internalWorkspaceId = request.headers.get("x-workspace-id");
    if (internalWorkspaceId && verifyInternalSecret(request)) {
      workspaceId = internalWorkspaceId;
      isInternal = true;
    } else {
      const authResult = await requireAuth();
      if (authResult.error) return authResult.error;
      workspaceId = request.nextUrl.searchParams.get("workspaceId") || undefined;
      if (!workspaceId) {
        return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
      }
      // An installation token can write to the connected repos, so a viewer must
      // not mint one. The agent path above is unaffected: it acts for the
      // workspace through the internal secret.
      const memberCheck = await requireWorkspaceMembership(
        authResult.user.id,
        workspaceId,
        Role.MEMBER,
      );
      if (memberCheck.error) return memberCheck.error;
      if (isDemoViewer(workspaceId, memberCheck.membership.role)) {
        return NextResponse.json({ error: DEMO_VIEWER_FORBIDDEN }, { status: 403 });
      }
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

    // The agent only reads: its token is limited to read access on the one
    // requested repository (every repository of the installation when no repo
    // is named, as for a status check).
    let scope: InstallationTokenScope | undefined;
    if (isInternal) {
      scope = { permissions: { ...AGENT_PERMISSIONS } };
      if (repo) {
        const repoName = repo.split("/")[1];
        if (!repoName || !REPO_NAME_RE.test(repoName)) {
          return NextResponse.json({ error: "Invalid repo" }, { status: 400 });
        }
        scope.repositories = [repoName];
      }
    }

    const { token, expires_at } = await getInstallationToken(
      chosen.installationId,
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      scope,
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
export const GET = withImpersonationPolicy(handleGET);
