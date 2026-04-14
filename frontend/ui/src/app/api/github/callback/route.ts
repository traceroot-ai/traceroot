import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import {
  GITHUB_AUTH_STATE_COOKIE,
  GITHUB_INSTALL_STATE_COOKIE,
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
    const authState = request.cookies.get(GITHUB_AUTH_STATE_COOKIE)?.value ?? null;
    const installState = request.cookies.get(GITHUB_INSTALL_STATE_COOKIE)?.value ?? null;
    // Match against the URL state to avoid false-positive CSRF errors when both cookies exist.
    // GitHub echoes back the exact state we sent, so the matching cookie is always the right one.
    const storedState =
      state === authState ? authState : state === installState ? installState : null;

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
    // Direct Github install flow, do not process yet
    if (validation.isDirectGitHubInstall && code) {
      const confirmUrl = new URL("/auth/github/confirm", env.BETTER_AUTH_URL);
      confirmUrl.searchParams.set("code", code);
      if (installationId) {
        confirmUrl.searchParams.set("installation_id", installationId);
      }
      if (setupAction) {
        confirmUrl.searchParams.set("setup_action", setupAction);
      }
      return NextResponse.redirect(confirmUrl);
    }
    // Normal Oauth Flow
    if (!code) {
      return NextResponse.json({ error: "Missing code parameter" }, { status: 400 });
    }

    return await processGitHubCallback(request, code, installationId);
  } catch (error) {
    console.error("GitHub callback error:", error);
    return NextResponse.json(
      { error: "Failed to complete GitHub authentication" },
      { status: 500 },
    );
  }
}

//helper function to validate callback parameters

async function processGitHubCallback(
  request: NextRequest,
  code: string,
  installationId: string | null,
) {
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

  // Get the return URL from cookie (will be used after installation completes).
  // Guard against open redirect: only accept relative paths. new URL(absolute, base)
  // ignores the base entirely, so an absolute URL in the cookie would escape the origin.
  const rawReturnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";
  const returnTo = rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";

  // If we already have installation_id (from direct GitHub install), redirect to returnTo.
  // Otherwise, redirect to the installation flow.
  const redirectUrl = resolvedInstallationId
    ? new URL(returnTo, env.BETTER_AUTH_URL)
    : new URL(`/api/github/install?returnTo=${encodeURIComponent(returnTo)}`, env.BETTER_AUTH_URL);

  // Use BETTER_AUTH_URL as base — request.url inside Docker resolves to 0.0.0.0
  // which loses the session cookie (set on localhost).

  // Returns JSON for POST requests, Redirect for GET requests.
  const response =
    request.method === "POST"
      ? NextResponse.json({ success: true, redirectUrl: redirectUrl.toString() })
      : NextResponse.redirect(redirectUrl);

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

  // Clear install state cookie
  response.cookies.set(GITHUB_INSTALL_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}

export async function POST(request: NextRequest) {
  try {
    // This endpoint is exclusively used by the direct GitHub install flow (confirm/page.tsx).
    // In that flow, the user arrived from GitHub's UI directly and no state cookie was ever set by us,
    // so validateCallbackParams is intentionally NOT called here (the state check would always fail
    // because storedState is null by design). Security is enforced by:
    //   1. Origin header check (same-origin enforcement below)
    //   2. GitHub validating the OAuth code on exchange (one-time use, short TTL)
    //   3. requireAuth() — user must have an active Traceroot session
    //   4. verifyInstallationId() — installation_id must belong to the authenticated GitHub user
    const origin = request.headers.get("origin");
    let parsedOrigin: string;
    try {
      parsedOrigin = origin ? new URL(origin).origin : "";
    } catch {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }
    if (parsedOrigin !== new URL(env.BETTER_AUTH_URL).origin) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }
    const body = await request.json();
    const { code, installationId } = body;

    if (!code) {
      return NextResponse.json({ error: "Missing code parameter" }, { status: 400 });
    }
    return await processGitHubCallback(request, code, installationId);
  } catch (error) {
    console.error("GitHub callback error:", error);
    return NextResponse.json(
      { error: "Failed to complete GitHub authentication" },
      { status: 500 },
    );
  }
}
