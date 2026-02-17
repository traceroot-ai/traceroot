import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

// Load GitHub OAuth config from environment variables
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

/**
 * GET /api/auth/github/start
 * Generates a CSRF state token, stores it in an httpOnly cookie,
 * and redirects the browser to GitHub's OAuth authorization page.
 */
export async function GET(): Promise<NextResponse> {
  if (!GITHUB_CLIENT_ID) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured" },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/api/auth/github/callback`;

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", "repo read:user user:email");
  githubAuthUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(githubAuthUrl.toString());
  response.cookies.set("github_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10, // 10 minutes
    path: "/",
  });

  return response;
}
