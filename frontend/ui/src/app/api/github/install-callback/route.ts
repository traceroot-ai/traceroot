import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import {
  GITHUB_INSTALL_STATE_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
  GITHUB_RETURN_TO_COOKIE,
  GITHUB_WORKSPACE_ID_COOKIE,
  getInstallation,
} from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    const installationId = request.nextUrl.searchParams.get("installation_id");
    const state = request.nextUrl.searchParams.get("state");

    if (!installationId || !state) {
      return NextResponse.json(
        { error: "Missing installation_id or state parameter" },
        { status: 400 },
      );
    }

    // Validate CSRF state
    const storedState = request.cookies.get(GITHUB_INSTALL_STATE_COOKIE)?.value;
    if (!storedState || storedState !== state) {
      return NextResponse.json({ error: "Invalid state parameter" }, { status: 403 });
    }

    // Require authenticated session
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    // Workspace must come from the cookie set by /api/github/install. Falling
    // back to "user's first workspace" can attach the install to the wrong
    // workspace for users in multiple workspaces — force them to start the
    // install from a workspace settings page so the cookie is set correctly.
    const workspaceId = request.cookies.get(GITHUB_WORKSPACE_ID_COOKIE)?.value;
    if (!workspaceId) {
      return NextResponse.json(
        {
          error:
            "Missing workspace context for installation. Start installation from a workspace settings page.",
        },
        { status: 400 },
      );
    }

    // ADMIN-only: writing the workspace's GitHub installation mutates a shared
    // resource. The state cookie alone is not enough — a non-admin member could
    // still complete this flow if they obtained a state cookie somehow.
    const memberCheck = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
    if (memberCheck.error) return memberCheck.error;

    // Fetch installation details (account.login) using the App's JWT — no user
    // OAuth token required. This is the source of truth for which org/user the
    // App is installed on.
    let accountLogin: string;
    try {
      const installation = await getInstallation(
        installationId,
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
      );
      accountLogin = installation.account.login;
    } catch (e) {
      console.error("Failed to fetch installation details:", e);
      return NextResponse.json(
        { error: "Failed to fetch installation details from GitHub" },
        { status: 502 },
      );
    }

    // Upsert workspace-level installation row.
    await prisma.gitHubInstallation.upsert({
      where: {
        workspaceId_installationId: { workspaceId, installationId },
      },
      create: {
        workspaceId,
        installationId,
        accountLogin,
        installedByUserId: user.id,
      },
      update: { accountLogin },
    });

    // Redirect to return URL
    const returnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";
    const response = NextResponse.redirect(new URL(returnTo, env.BETTER_AUTH_URL));

    // Clear state cookies
    response.cookies.set(GITHUB_INSTALL_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    response.cookies.set(GITHUB_RETURN_TO_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    response.cookies.set(GITHUB_WORKSPACE_ID_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    // Set installation ID cookie (NOT httpOnly so client can read it)
    response.cookies.set(GITHUB_INSTALLATION_ID_COOKIE, installationId, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("GitHub install callback error:", error);
    return NextResponse.json(
      { error: "Failed to complete GitHub App installation" },
      { status: 500 },
    );
  }
}
