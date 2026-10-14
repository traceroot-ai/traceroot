import { NextRequest, NextResponse } from "next/server";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  encodeAttributionCookie,
  getUtmParams,
  readAttributionCookie,
} from "@/lib/marketing-attribution";

export function proxy(req: NextRequest) {
  // better-auth prefixes cookies with __Secure- in HTTPS environments
  const token =
    req.cookies.get("better-auth.session_token") ??
    req.cookies.get("__Secure-better-auth.session_token");

  const utm = getUtmParams(req.nextUrl.searchParams);
  let response = NextResponse.next();
  // Auth pages remain public. /device owns its sign-in round-trip, preserving
  // the user_code; approval still requires a session in its server handler.
  if (!token && !req.nextUrl.pathname.startsWith("/auth/") && req.nextUrl.pathname !== "/device") {
    const signInUrl = new URL("/auth/sign-in", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    for (const [key, value] of Object.entries(utm)) signInUrl.searchParams.set(key, value);
    response = NextResponse.redirect(signInUrl);
  }

  if (
    !token &&
    req.method === "GET" &&
    process.env.NEXT_PUBLIC_POSTHOG_KEY &&
    process.env.NEXT_PUBLIC_POSTHOG_HOST &&
    Object.keys(utm).length
  ) {
    const previous = readAttributionCookie(req.headers.get("cookie"), Date.now());
    // Forwarded UTMs and auth-page navigation must not restart the expiry window.
    if (JSON.stringify(previous?.utm) !== JSON.stringify(utm)) {
      const value = encodeAttributionCookie({ capturedAt: Date.now(), utm });
      if (value)
        response.cookies.set(ATTRIBUTION_COOKIE, value, {
          path: "/",
          maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
          sameSite: "lax",
          secure: req.nextUrl.protocol === "https:",
        });
    }
  }
  return response;
}

export const config = {
  matcher: [
    // Protect all routes except:
    // - api/auth (auth routes)
    // - api/public (API-key-authed SDK routes; auth via requireApiKeyProject, not a session cookie)
    // - api/internal (internal API for Python backend, uses X-Internal-Secret)
    // - api/cli (CLI token exchange, authenticates by bearer session token, no cookie)
    // - api/billing/webhook (Stripe webhook, uses signature verification)
    // - api/email/unsubscribe (signed-token authed; reached from email links and one-click POSTs, no cookie)
    // - api/health, exact (load balancer / kubelet liveness probe; a 307 here reads as unhealthy)
    // - _next (Next.js internals)
    // - static files
    "/((?!api/auth|api/public|api/internal|api/cli|api/billing/webhook|api/email/unsubscribe|api/health$|api/github/token|api/github/callback|api/github/install-callback|_next/static|_next/image|images/|favicon.ico).*)",
  ],
};
