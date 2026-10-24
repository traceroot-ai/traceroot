import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

/**
 * The middleware matcher is Next's negative-lookahead form: a path is PROTECTED
 * (the session-cookie middleware runs, redirecting to /auth/sign-in when there's
 * no cookie) iff it matches. Surfaces with their own auth — API-key public routes
 * (requireApiKeyProject), the internal API (X-Internal-Secret), auth routes — MUST
 * be exempt, or their requests get 307'd to sign-in before their handler runs.
 *
 * Regression guard for the api/public omission that 307'd every SDK request.
 */
const matcher = config.matcher[0];
const re = new RegExp(`^${matcher}$`);
const isProtected = (path: string) => re.test(path);

describe("middleware matcher exemptions", () => {
  it("exempts API-key public routes (Bearer auth, not a session cookie)", () => {
    expect(isProtected("/api/public/datasets")).toBe(false);
    expect(isProtected("/api/public/datasets/ds1/versions")).toBe(false);
    expect(isProtected("/api/public/evaluation-runs/run1/results/tc1/scores")).toBe(false);
  });

  it("exempts the other non-session surfaces", () => {
    expect(isProtected("/api/auth/callback")).toBe(false);
    expect(isProtected("/api/internal/validate-api-key")).toBe(false);
    expect(isProtected("/api/billing/webhook")).toBe(false);
    expect(isProtected("/api/email/unsubscribe")).toBe(false);
    expect(isProtected("/api/health")).toBe(false);
    // Browsers post Content-Security-Policy violation reports without the session.
    expect(isProtected("/api/csp-report")).toBe(false);
  });

  it("matches auth pages so they get the Content-Security-Policy; proxy() lets them through", () => {
    expect(isProtected("/auth/sign-in")).toBe(true);
    expect(isProtected("/auth/sign-up")).toBe(true);
  });

  it("exempts only the exact health path, not neighbours", () => {
    expect(isProtected("/api/healthcheck")).toBe(true);
    expect(isProtected("/api/health/deep")).toBe(true);
  });

  it("still protects app pages and session-authed API routes", () => {
    expect(isProtected("/projects/p1/datasets")).toBe(true);
    expect(isProtected("/api/projects/p1/datasets")).toBe(true);
  });
});

function request(path: string, opts?: { token?: boolean; https?: boolean }): NextRequest {
  const headers = new Headers();
  if (opts?.token) {
    headers.set("cookie", "better-auth.session_token=a-token");
  }
  const scheme = opts?.https ? "https" : "http";
  return new NextRequest(new URL(`${scheme}://localhost:3000${path}`), { headers });
}

// The sign-in page reads the callback with searchParams.get(), which decodes
// one layer — so assert on the decoded value a nested callback arrives as.
function callback(res: Response): string | null {
  const location = res.headers.get("location");
  expect(location).toContain("/auth/sign-in");
  return new URL(location!).searchParams.get("callbackUrl");
}

describe("proxy middleware", () => {
  it("lets the device page through without a token so it can keep its ?user_code", () => {
    // The bug this guards: redirecting here would drop the query (pathname-only
    // callbackUrl), losing the device code across the sign-in round-trip.
    const res = proxy(request("/device?user_code=ABCD1234"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets auth pages through without a token", () => {
    const res = proxy(request("/auth/sign-in"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a protected route to sign-in when unauthenticated", () => {
    const res = proxy(request("/projects/p1/traces"));
    const location = res.headers.get("location");
    expect(location).toContain("/auth/sign-in");
    expect(location).toContain("callbackUrl=");
  });

  it("allows a protected route when a session token is present", () => {
    const res = proxy(request("/projects/p1/traces", { token: true }));
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the query string in the callback so a waiting terminal is still reachable", () => {
    // /onboarding carries the pointer back to a blocked `traceroot setup` run in
    // its own ?callbackUrl. A pathname-only value drops it, and the visitor
    // finishes onboarding with nothing on screen leading back to the terminal.
    const res = proxy(request("/onboarding?callbackUrl=%2Fdevice%3Fuser_code%3DABCD1234"));
    expect(callback(res)).toBe("/onboarding?callbackUrl=%2Fdevice%3Fuser_code%3DABCD1234");
  });

  it("keeps the query string for any protected page, not just onboarding", () => {
    const res = proxy(request("/projects/p1/traces?traceId=t1&tab=spans"));
    expect(callback(res)).toBe("/projects/p1/traces?traceId=t1&tab=spans");
  });

  it("still sends a bare path when the request has no query", () => {
    const res = proxy(request("/projects/p1/traces"));
    expect(callback(res)).toBe("/projects/p1/traces");
  });

  it("refuses a callback whose path resolves off-origin instead of carrying it onward", () => {
    // A request to `//host/x` arrives with a protocol-relative pathname, which
    // re-parses cross-origin wherever it is followed.
    expect(callback(proxy(request("//evil.example/onboarding?callbackUrl=%2Fdevice")))).toBe("/");
    expect(callback(proxy(request("/..//evil.example?user_code=ABCD1234")))).toBe("/");
  });
});

// NextResponse.next({ request: { headers } }) hands each overridden request header
// to rendering as x-middleware-request-<name>.
function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

describe("proxy Content-Security-Policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives the sign-in page a policy and hands its nonce to rendering", () => {
    const res = proxy(request("/auth/sign-in"));
    const policy = res.headers.get("content-security-policy");
    const nonce = forwarded(res, "x-nonce");

    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
    // Next.js finds the nonce for its own scripts in the request's copy.
    expect(forwarded(res, "content-security-policy")).toBe(policy);
  });

  it("names the endpoint the policy's report-to sends reports to on a page served over HTTPS", () => {
    const res = proxy(request("/auth/sign-in", { https: true }));
    expect(res.headers.get("content-security-policy")).toContain("report-to csp-endpoint");
    expect(res.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
  });

  it("leaves report-to and its endpoint out of a page served over plain HTTP, whatever the app URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    const res = proxy(request("/auth/sign-in"));
    expect(res.headers.get("content-security-policy")).toContain("report-uri /api/csp-report");
    expect(res.headers.get("content-security-policy")).not.toContain("report-to");
    expect(res.headers.get("reporting-endpoints")).toBeNull();
  });

  it("uses a new nonce for every request", () => {
    const first = forwarded(proxy(request("/auth/sign-in")), "x-nonce");
    const second = forwarded(proxy(request("/auth/sign-in")), "x-nonce");
    expect(first).not.toBe(second);
  });

  it("adds the policy to the device page and to pages for a signed-in visitor", () => {
    expect(
      proxy(request("/device?user_code=ABCD1234")).headers.get("content-security-policy"),
    ).toContain("'strict-dynamic'");
    expect(
      proxy(request("/projects/p1/traces", { token: true })).headers.get("content-security-policy"),
    ).toContain("frame-ancestors 'none'");
  });

  it("sends no policy with the sign-in redirect or with API responses", () => {
    expect(proxy(request("/projects/p1/traces")).headers.get("content-security-policy")).toBeNull();
    const api = proxy(request("/api/projects/p1/datasets", { token: true }));
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("reporting-endpoints")).toBeNull();
    expect(forwarded(api, "x-nonce")).toBeNull();
  });

  it("only reports violations when CSP_MODE=report-only", () => {
    vi.stubEnv("CSP_MODE", "report-only");
    const res = proxy(request("/auth/sign-in"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toContain("'strict-dynamic'");
    expect(forwarded(res, "content-security-policy-report-only")).toBeTruthy();
  });
});
