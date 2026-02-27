import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { requireAuth } from "@/lib/auth-helpers";
import { GITHUB_AUTH_STATE_COOKIE, GITHUB_RETURN_TO_COOKIE } from "@traceroot/github";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;

    const state = crypto.randomUUID();
    const returnTo = request.nextUrl.searchParams.get("returnTo") || "/";

    const params = new URLSearchParams({
      client_id: env.GITHUB_APP_CLIENT_ID,
      redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
      state,
      scope: "read:user,user:email",
    });

    const redirectUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(GITHUB_AUTH_STATE_COOKIE, state, {
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
    console.error("GitHub login error:", error);
    return NextResponse.json({ error: "Failed to initiate GitHub login" }, { status: 500 });
  }
}
