import { NextRequest, NextResponse } from "next/server";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  encodeAttributionCookie,
  getUtmParams,
} from "@/lib/marketing-attribution";
import { buildContentSecurityPolicy, cspHeaderName, REPORTING_ENDPOINTS } from "@/lib/csp";

// Every page carries a Content-Security-Policy with a fresh nonce (lib/csp.ts).
// Next.js reads the nonce from the policy on the request and adds it to its own
// scripts; the root layout reads x-nonce for the theme script.
function nextWithCsp(req: NextRequest): NextResponse {
  // API routes answer with JSON rather than a page, so a policy would do nothing.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Next.js takes the scheme from the TLS connection, or from X-Forwarded-Proto
  // behind a proxy that terminates TLS.
  const https = req.nextUrl.protocol === "https:";
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    https,
  });
  const header = cspHeaderName(process.env.CSP_MODE);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  if (https) {
    response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
  }
  return response;
}

export function proxy(req: NextRequest) {
  // better-auth prefixes cookies with __Secure- in HTTPS environments
  const token =
    req.cookies.get("better-auth.session_token") ??
    req.cookies.get("__Secure-better-auth.session_token");

  const utm = getUtmParams(req.nextUrl.searchParams);
  let response: NextResponse;
  // Auth pages remain public. /device owns its sign-in round-trip, preserving
  // the user_code; approval still requires a session in its server handler.
  if (!token && !req.nextUrl.pathname.startsWith("/auth/") && req.nextUrl.pathname !== "/device") {
    const signInUrl = new URL("/auth/sign-in", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    for (const [key, value] of Object.entries(utm)) signInUrl.searchParams.set(key, value);
    response = NextResponse.redirect(signInUrl);
  } else {
    response = nextWithCsp(req);
  }

  if (
    !token &&
    req.method === "GET" &&
    process.env.NEXT_PUBLIC_POSTHOG_KEY &&
    process.env.NEXT_PUBLIC_POSTHOG_HOST &&
    Object.keys(utm).length
  ) {
    // The same campaign can bring a visitor back later. Refresh every tagged
    // visit, accepting the small timestamp shift on the forwarded sign-in hop.
    const value = encodeAttributionCookie({ capturedAt: Date.now(), utm });
    if (value)
      response.cookies.set(ATTRIBUTION_COOKIE, value, {
        path: "/",
        maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
        sameSite: "lax",
        secure: req.nextUrl.protocol === "https:",
      });
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
    // - api/csp-report (browsers post policy violation reports without the session)
    // - _next (Next.js internals)
    // - static files
    // auth/* pages (sign-in, sign-up) are matched so they get the policy;
    // proxy() lets them through without a session.
    "/((?!api/auth|api/public|api/internal|api/cli|api/billing/webhook|api/email/unsubscribe|api/health$|api/csp-report|api/github/token|api/github/callback|api/github/install-callback|_next/static|_next/image|images/|favicon.ico).*)",
  ],
};
