import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth } from "@/lib/auth-helpers";
import {
  GITHUB_INSTALL_STATE_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
  GITHUB_RETURN_TO_COOKIE,
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

    // Only update installationId on an existing connection (OAuth must complete first)
    const updated = await prisma.gitHubConnection.updateMany({
      where: { userId: user.id },
      data: { installationId },
    });

    if (updated.count === 0) {
      // No OAuth connection exists yet — redirect to OAuth flow first
      const returnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";
      return NextResponse.redirect(
        new URL(`/api/github/login?returnTo=${encodeURIComponent(returnTo)}`, request.url),
      );
    }

    // Redirect to return URL
    const returnTo = request.cookies.get(GITHUB_RETURN_TO_COOKIE)?.value || "/";
    const response = NextResponse.redirect(new URL(returnTo, request.url));

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
