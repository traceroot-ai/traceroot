import { NextRequest, NextResponse } from "next/server";

// GET /oauth/continue
//
// Where the OAuth provider sends a user who is not signed in. The proxy has
// already put a signed-out visitor through the normal sign-in page and brought
// them back here, so by now there is a session: hand the authorization request
// (its signed query, untouched) back to the provider to carry on. The target is
// fixed, so the query cannot point this anywhere else.
//
// The redirect is relative on purpose. Behind a container or a proxy
// `request.url` can carry the address the server is bound to (0.0.0.0) rather
// than the host the browser used, and an absolute redirect to that host leaves
// the session cookie behind and bounces the user back to sign-in.
export function GET(request: NextRequest) {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: `/api/auth/oauth2/authorize${request.nextUrl.search}` },
  });
}
