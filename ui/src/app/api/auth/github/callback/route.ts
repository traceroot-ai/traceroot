import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { connectToDatabase } from "@/lib/mongodb";
import { ConnectionToken } from "@/models/token";
import { LOCAL_USER } from "@/lib/self-host-constants";

// Load GitHub OAuth config from environment variables
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const IS_LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

/**
 * GET /api/auth/github/callback?code=xxx&state=xxx
 * Exchanges the GitHub OAuth code for an access token and stores it.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Validate CSRF state
  const storedState = request.cookies.get("github_oauth_state")?.value;
  if (!state || !storedState || state !== storedState) {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
  }

  // Exchange code for access token
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    },
  );

  if (!tokenResponse.ok) {
    return NextResponse.json(
      { error: "Failed to exchange authorization code" },
      { status: 502 },
    );
  }

  const tokenData = await tokenResponse.json();

  if (tokenData.error || !tokenData.access_token) {
    return NextResponse.json(
      { error: tokenData.error_description || "GitHub denied the request" },
      { status: 400 },
    );
  }

  const accessToken: string = tokenData.access_token;

  // Resolve user identity — mirrors post_connect/route.ts logic
  let userEmail: string;

  if (IS_LOCAL_MODE) {
    userEmail = LOCAL_USER.USER_EMAIL;
  } else {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.redirect(`${APP_URL}/sign-in`);
    }

    const user = await currentUser();
    if (!user) {
      return NextResponse.redirect(`${APP_URL}/sign-in`);
    }

    const clerkUserEmail = user.emailAddresses[0]?.emailAddress;
    if (!clerkUserEmail) {
      return NextResponse.json(
        { error: "User email not found" },
        { status: 401 },
      );
    }

    userEmail = clerkUserEmail;
  }

  // Store token in connection_tokens (same path as post_connect)
  await connectToDatabase();
  await ConnectionToken.updateOne(
    { user_email: userEmail, token_type: "github" },
    {
      $set: { user_email: userEmail, token: accessToken, token_type: "github" },
    },
    { upsert: true },
  );

  // Clear CSRF cookie and redirect back to integrations page
  const response = NextResponse.redirect(
    `${APP_URL}/integrate?github=connected`,
  );
  response.cookies.delete("github_oauth_state");
  return response;
}
