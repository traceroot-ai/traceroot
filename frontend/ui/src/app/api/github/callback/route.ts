import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@traceroot/core";
import { requireAuth, requireWorkspaceMembership } from "@/lib/auth-helpers";
import {
  GITHUB_AUTH_STATE_COOKIE,
  GITHUB_INSTALL_STATE_COOKIE,
  GITHUB_RETURN_TO_COOKIE,
  GITHUB_WORKSPACE_ID_COOKIE,
  validateCallbackParams,
} from "@traceroot/github";

interface UserInstallation {
  id: number | string;
  app_id: number | string;
  account: { login: string };
}

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
    // Direct GitHub install flow — defer to the confirm page (re-POSTs here).
    if (validation.isDirectGitHubInstall && code) {
      const confirmUrl = new URL("/auth/github/confirm", env.BETTER_AUTH_URL);
      confirmUrl.searchParams.set("code", code);
      if (installationId) confirmUrl.searchParams.set("installation_id", installationId);
      if (setupAction) confirmUrl.searchParams.set("setup_action", setupAction);
      return NextResponse.redirect(confirmUrl);
    }
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

async function processGitHubCallback(
  request: NextRequest,
  code: string,
  installationIdParam: string | null,
) {
  // 1. Exchange OAuth code for access token (used once to query user installations; not stored).
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  });
  const { access_token: accessToken } = await tokenResponse.json();
  if (!accessToken) {
    return NextResponse.json({ error: "Failed to exchange code for token" }, { status: 500 });
  }

  // 2. Require Traceroot session.
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  // 3. List the user's installations of our App. The /user/installations response
  //    already contains account.login, so we don't need a separate getInstallation call.
  const installRes = await fetch("https://api.github.com/user/installations", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "TraceRoot",
    },
  });
  const installData = installRes.ok ? await installRes.json() : { installations: [] };
  const myInstalls: UserInstallation[] = (installData.installations || []).filter(
    (i: UserInstallation) => String(i.app_id) === env.GITHUB_APP_ID,
  );

  // 4. Pick which install to attach. If installation_id was passed in the URL,
  //    it must be one of the user's installs of our App (security check).
  //    Otherwise, take the first install they have for our App (if any).
  let chosen: UserInstallation | undefined;
  if (installationIdParam) {
    chosen = myInstalls.find((i) => String(i.id) === installationIdParam);
    if (!chosen) {
      return NextResponse.json(
        { error: "Installation ID does not belong to authenticated user" },
        { status: 403 },
      );
    }
  } else {
    chosen = myInstalls[0];
  }

  // 5. Resolve target workspace: cookie set at /api/github/login kickoff, or
  //    the user's first membership for the direct-install flow (where the user
  //    started at github.com and we never set the cookie).
  let workspaceId = request.cookies.get(GITHUB_WORKSPACE_ID_COOKIE)?.value;
  if (!workspaceId) {
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: user.id },
      orderBy: { createTime: "asc" },
      select: { workspaceId: true },
    });
    workspaceId = membership?.workspaceId;
  }

  // 6. Persist the install if both pieces are known. If we have no install yet,
  //    we'll bounce through /api/github/install — that flow ends in install-callback,
  //    which writes the row. ADMIN-gated: writing a workspace integration is admin-only.
  if (chosen && workspaceId) {
    const memberCheck = await requireWorkspaceMembership(user.id, workspaceId, "ADMIN");
    if (memberCheck.error) return memberCheck.error;

    const installationId = String(chosen.id);
    await prisma.gitHubInstallation.upsert({
      where: { workspaceId_installationId: { workspaceId, installationId } },
      create: {
        workspaceId,
        installationId,
        accountLogin: chosen.account.login,
        installedByUserId: user.id,
      },
      update: { accountLogin: chosen.account.login },
    });
  }

  // 7. Build the redirect.
  const rawReturnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";
  // Guard against open redirect: only accept relative paths. new URL(absolute, base)
  // ignores the base entirely, so an absolute URL in the cookie would escape the origin.
  const returnTo = rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";
  // Use BETTER_AUTH_URL as base — request.url inside Docker resolves to 0.0.0.0
  // which loses the session cookie (set on localhost).
  // Mirror the persistence condition (chosen && workspaceId): if either is
  // missing we didn't write a row, so we shouldn't redirect "as connected".
  const redirectUrl =
    chosen && workspaceId
      ? new URL(returnTo, env.BETTER_AUTH_URL)
      : new URL(
          `/api/github/install?returnTo=${encodeURIComponent(returnTo)}`,
          env.BETTER_AUTH_URL,
        );

  const response =
    request.method === "POST"
      ? NextResponse.json({ success: true, redirectUrl: redirectUrl.toString() })
      : NextResponse.redirect(redirectUrl);

  // Clear OAuth state cookie regardless. Clear return-to / install-state /
  // workspace cookies only after we've persisted the row (so install-callback
  // can still read return-to and workspace if we redirect to install instead).
  const clearCookie = (name: string) =>
    response.cookies.set(name, "", { httpOnly: true, sameSite: "lax", maxAge: 0, path: "/" });
  clearCookie(GITHUB_AUTH_STATE_COOKIE);
  if (chosen && workspaceId) {
    clearCookie(GITHUB_RETURN_TO_COOKIE);
    clearCookie(GITHUB_INSTALL_STATE_COOKIE);
    clearCookie(GITHUB_WORKSPACE_ID_COOKIE);
  }

  return response;
}

export async function POST(request: NextRequest) {
  try {
    // Used exclusively by the direct GitHub install confirm page. State check
    // is intentionally skipped (no cookie set in that flow); security is enforced by:
    //   1. Origin header check (same-origin)
    //   2. GitHub validating the OAuth code on exchange
    //   3. requireAuth() — user must have an active Traceroot session
    //   4. installation_id must appear in the user's /user/installations
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
