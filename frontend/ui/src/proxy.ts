import { NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  // better-auth prefixes cookies with __Secure- in HTTPS environments
  const token =
    req.cookies.get("better-auth.session_token") ??
    req.cookies.get("__Secure-better-auth.session_token");

  // Allow auth pages without token
  if (req.nextUrl.pathname.startsWith("/auth/")) {
    return NextResponse.next();
  }

  // The device consent page owns its own sign-in round-trip: it must preserve
  // the ?user_code query and stash it across the redirect (this middleware would
  // otherwise redirect with a pathname-only callbackUrl, dropping the code). The
  // sensitive action (approve) is enforced server-side to require the claiming
  // session, so leaving the page reachable without a token is safe.
  if (req.nextUrl.pathname === "/device") {
    return NextResponse.next();
  }

  // No token → redirect to sign-in
  if (!token) {
    const signInUrl = new URL("/auth/sign-in", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect all routes except:
    // - api/auth (auth routes)
    // - api/public (API-key-authed SDK routes; auth via requireApiKeyProject, not a session cookie)
    // - api/internal (internal API for Python backend, uses X-Internal-Secret)
    // - api/cli (CLI token exchange, authenticates by bearer session token, no cookie)
    // - api/billing/webhook (Stripe webhook, uses signature verification)
    // - auth/* (sign-in, sign-up pages)
    // - _next (Next.js internals)
    // - static files
    "/((?!api/auth|api/public|api/internal|api/cli|api/billing/webhook|api/github/token|api/github/callback|api/github/install-callback|auth/|_next/static|_next/image|images/|favicon.ico).*)",
  ],
};
