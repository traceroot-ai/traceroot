import { describe, expect, it } from "vitest";
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
  });

  it("still protects app pages and session-authed API routes", () => {
    expect(isProtected("/projects/p1/datasets")).toBe(true);
    expect(isProtected("/api/projects/p1/datasets")).toBe(true);
  });
});

function request(path: string, opts?: { token?: boolean }): NextRequest {
  const headers = new Headers();
  if (opts?.token) {
    headers.set("cookie", "better-auth.session_token=a-token");
  }
  return new NextRequest(new URL(`http://localhost:3000${path}`), { headers });
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
});
