import { NextResponse } from "next/server";

/**
 * GET /api/auth/github/manage
 * Redirects to the GitHub settings page where the user can review
 * or revoke TraceRoot's OAuth permissions.
 */
export async function GET(): Promise<NextResponse> {
  const clientId = process.env.GITHUB_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured" },
      { status: 500 },
    );
  }

  return NextResponse.redirect(
    `https://github.com/settings/connections/applications/${clientId}`,
  );
}
