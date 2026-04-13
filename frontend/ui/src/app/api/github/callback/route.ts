import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import {
  GITHUB_AUTH_STATE_COOKIE,
  GITHUB_RETURN_TO_COOKIE,
  validateCallbackParams,
  verifyInstallationId,
} from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const installationId = request.nextUrl.searchParams.get("installation_id");
    const setupAction = request.nextUrl.searchParams.get("setup_action");
    const storedState = request.cookies.get(GITHUB_AUTH_STATE_COOKIE)?.value ?? null;

    // Validate callback parameters (handles both normal OAuth and direct GitHub install flows)
    const validation = validateCallbackParams({
      code,
      state,
      installationId,
      setupAction,
      storedState,
    });

    if (!validation.valid) {
      const status = validation.error === "Missing code or state parameter" ? 400 : 403;
      return NextResponse.json({ error: validation.error }, { status });
    }

    // Exchange code for access token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("GitHub OAuth token exchange failed:", tokenData);
      return NextResponse.json({ error: "Failed to exchange code for token" }, { status: 500 });
    }

    // Fetch GitHub user info
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "TraceRoot",
      },
    });

    if (!userResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch GitHub user info" }, { status: 500 });
    }

    const ghUser = await userResponse.json();

    // Require authenticated session
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    // Look up GitHub App installations for this user and verify/resolve installation_id.
    // If installation_id was passed in URL (direct GitHub install), we verify it belongs
    // to this user. Otherwise, we look up an existing installation.
    let resolvedInstallationId: string | undefined;
    try {
      const installRes = await fetch("https://api.github.com/user/installations", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "TraceRoot",
        },
      });
      if (installRes.ok) {
        const data = await installRes.json();
        const installationCheck = verifyInstallationId(
          installationId,
          data.installations || [],
          env.GITHUB_APP_ID,
        );

        if (!installationCheck.verified) {
          console.error(installationCheck.error);
          return NextResponse.json(
            { error: "Installation ID does not belong to authenticated user" },
            { status: 403 },
          );
        }
        resolvedInstallationId = installationCheck.installationId;
      }
    } catch (e) {
      // Non-fatal — installationId will be filled later via install-callback
      console.warn("Failed to look up existing GitHub App installations:", e);
    }

    // Upsert GitHubConnection
    await prisma.gitHubConnection.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        githubUserId: String(ghUser.id),
        githubUsername: ghUser.login,
        accessToken,
        ...(resolvedInstallationId && { installationId: resolvedInstallationId }),
      },
      update: {
        githubUserId: String(ghUser.id),
        githubUsername: ghUser.login,
        accessToken,
        ...(resolvedInstallationId && { installationId: resolvedInstallationId }),
      },
    });

    // Get the return URL from cookie (will be used after installation completes)
    const returnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";

    // If we already have installation_id (from direct GitHub install), redirect to returnTo.
    // Otherwise, redirect to the installation flow.
    const redirectUrl = resolvedInstallationId
      ? new URL(returnTo, env.BETTER_AUTH_URL)
      : new URL(
          `/api/github/install?returnTo=${encodeURIComponent(returnTo)}`,
          env.BETTER_AUTH_URL,
        );

    // Use BETTER_AUTH_URL as base — request.url inside Docker resolves to 0.0.0.0
    // which loses the session cookie (set on localhost).
    const response = NextResponse.redirect(redirectUrl);

    // Clear OAuth state cookie
    response.cookies.set(GITHUB_AUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    // Clear return-to cookie
    response.cookies.set(GITHUB_RETURN_TO_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("GitHub callback error:", error);
    return NextResponse.json(
      { error: "Failed to complete GitHub authentication" },
      { status: 500 },
    );
  }
}
