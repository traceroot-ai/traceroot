import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { requireAuth } from "@/lib/auth-helpers";
import { GITHUB_INSTALL_STATE_COOKIE, GITHUB_RETURN_TO_COOKIE } from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;

    const state = crypto.randomUUID();
    const returnTo = request.nextUrl.searchParams.get("returnTo") || "/";

    const params = new URLSearchParams({ state });
    const redirectUrl = `https://github.com/apps/${env.GITHUB_APP_NAME}/installations/new?${params.toString()}`;
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(GITHUB_INSTALL_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    response.cookies.set(GITHUB_RETURN_TO_COOKIE, returnTo, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("GitHub install error:", error);
    return NextResponse.json(
      { error: "Failed to initiate GitHub App installation" },
      { status: 500 },
    );
  }
}
