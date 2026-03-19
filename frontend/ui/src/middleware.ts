import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  // better-auth prefixes cookies with __Secure- in HTTPS environments
  const token =
    req.cookies.get("better-auth.session_token") ??
    req.cookies.get("__Secure-better-auth.session_token");

  // Allow auth pages without token
  if (req.nextUrl.pathname.startsWith("/auth/")) {
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
    // - api/internal (internal API for Python backend, uses X-Internal-Secret)
    // - api/billing/webhook (Stripe webhook, uses signature verification)
    // - auth/* (sign-in, sign-up pages)
    // - _next (Next.js internals)
    // - static files
    "/((?!api/auth|api/internal|api/billing/webhook|api/github/token|api/github/callback|api/github/install-callback|auth/|_next/static|_next/image|images/|favicon.ico).*)",
  ],
};
