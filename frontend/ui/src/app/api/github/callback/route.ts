import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import { GITHUB_AUTH_STATE_COOKIE, GITHUB_RETURN_TO_COOKIE } from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.json({ error: "Missing code or state parameter" }, { status: 400 });
    }

    // Validate CSRF state
    const storedState = request.cookies.get(GITHUB_AUTH_STATE_COOKIE)?.value;
    if (!storedState || storedState !== state) {
      return NextResponse.json({ error: "Invalid state parameter" }, { status: 403 });
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
        "User-Agent": "Traceroot",
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

    // Look up existing GitHub App installations for this user.
    // If the app is already installed (e.g. by a teammate), we can grab the
    // installation_id now instead of relying on the install-callback redirect
    // (which GitHub skips for already-installed apps).
    let installationId: string | undefined;
    try {
      const installRes = await fetch("https://api.github.com/user/installations", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Traceroot",
        },
      });
      if (installRes.ok) {
        const data = await installRes.json();
        const appId = env.GITHUB_APP_ID;
        const installation = data.installations?.find(
          (inst: { app_id: number }) => String(inst.app_id) === appId,
        );
        if (installation) {
          installationId = String(installation.id);
        }
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
        ...(installationId && { installationId }),
      },
      update: {
        githubUserId: String(ghUser.id),
        githubUsername: ghUser.login,
        accessToken,
        ...(installationId && { installationId }),
      },
    });

    // Get the return URL from cookie (will be used after installation completes)
    const returnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";

    // Redirect to installation flow
    // Use NEXTAUTH_URL as base — request.url inside Docker resolves to 0.0.0.0
    // which loses the session cookie (set on localhost).
    const response = NextResponse.redirect(
      new URL(`/api/github/install?returnTo=${encodeURIComponent(returnTo)}`, env.NEXTAUTH_URL),
    );

    // Clear OAuth state cookie
    response.cookies.set(GITHUB_AUTH_STATE_COOKIE, "", {
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
