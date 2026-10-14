import { NextRequest, NextResponse } from "next/server";
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

  // Allow auth pages without token
  if (req.nextUrl.pathname.startsWith("/auth/")) {
    return nextWithCsp(req);
  }

  // The device consent page owns its own sign-in round-trip: it must preserve
  // the ?user_code query and stash it across the redirect (this middleware would
  // otherwise redirect with a pathname-only callbackUrl, dropping the code). The
  // sensitive action (approve) is enforced server-side to require the claiming
  // session, so leaving the page reachable without a token is safe.
  if (req.nextUrl.pathname === "/device") {
    return nextWithCsp(req);
  }

  // No token → redirect to sign-in
  if (!token) {
    const signInUrl = new URL("/auth/sign-in", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return nextWithCsp(req);
}

export const config = {
  matcher: [
    // Protect all routes except:
    // - api/auth (auth routes)
    // - api/public (API-key-authed, not a cookie; each route calls its own
    //   Bearer helper from lib/public-auth.ts or lib/eval/auth.ts, some of
    //   which also check the key's scope)
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
