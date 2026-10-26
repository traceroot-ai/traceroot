import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  ATTRIBUTION_MAX_COOKIE_LENGTH,
  readAttributionCookie,
} from "@/lib/marketing-attribution";
import { config, proxy } from "./proxy";

/**
 * API-key routes and auth callbacks own their authentication. Auth pages run
 * through the proxy to capture campaign cookies, but remain public.
 */
const matchesProxy = (path: string) => unstable_doesMiddlewareMatch({ config, url: path });

describe("middleware matcher exemptions", () => {
  it("exempts API-key public routes (Bearer auth, not a session cookie)", () => {
    expect(matchesProxy("/api/public/datasets")).toBe(false);
    expect(matchesProxy("/api/public/datasets/ds1/versions")).toBe(false);
    expect(matchesProxy("/api/public/evaluation-runs/run1/results/tc1/scores")).toBe(false);
  });

  it("exempts the other non-session surfaces", () => {
    expect(matchesProxy("/api/auth/callback")).toBe(false);
    expect(matchesProxy("/api/internal/validate-api-key")).toBe(false);
    expect(matchesProxy("/api/billing/webhook")).toBe(false);
    expect(matchesProxy("/api/email/unsubscribe")).toBe(false);
    expect(matchesProxy("/api/health")).toBe(false);
    expect(matchesProxy("/api/csp-report")).toBe(false);
  });

  it("exempts only the exact health path, not neighbours", () => {
    expect(matchesProxy("/api/healthcheck")).toBe(true);
    expect(matchesProxy("/api/health/deep")).toBe(true);
  });

  it("still protects app pages and session-authed API routes", () => {
    expect(matchesProxy("/projects/p1/datasets")).toBe(true);
    expect(matchesProxy("/api/projects/p1/datasets")).toBe(true);
  });

  it("runs on auth pages and the device page without making them protected", () => {
    expect(matchesProxy("/auth/sign-in")).toBe(true);
    expect(matchesProxy("/auth/sign-up")).toBe(true);
    expect(matchesProxy("/device?user_code=ABCD1234")).toBe(true);
  });
});

function request(
  path: string,
  opts?: { token?: boolean; cookies?: string; method?: string; origin?: string },
): NextRequest {
  const headers = new Headers();
  if (opts?.cookies) headers.set("cookie", opts.cookies);
  if (opts?.token) {
    headers.set("cookie", "better-auth.session_token=a-token");
  }
  return new NextRequest(new URL(path, opts?.origin ?? "http://localhost:3000"), {
    headers,
    method: opts?.method,
  });
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

  it("still protects /onboarding, which renders bare but is not public", () => {
    // /onboarding renders with no app shell around it, exactly as /device does
    // (see lib/chromeless-routes) — but for an unrelated reason, and the
    // exemption above must not follow the resemblance. /device is exempt
    // because it is reachable while SIGNED OUT and owns its own sign-in
    // round-trip; every action on /onboarding needs a session, and exempting it
    // would hand the workspace-creation form to anyone with the URL.
    //
    // Both halves, because either one alone can be made to pass: the middleware
    // never runs on a path the matcher does not claim, so dropping /onboarding
    // from `config.matcher` would make the page public with this redirect still
    // in place.
    expect(matchesProxy("/onboarding")).toBe(true);
    const res = proxy(request("/onboarding?callbackUrl=%2Fdevice"));
    expect(res.headers.get("location")).toContain("/auth/sign-in");
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

  it("preserves the callback query and forwards only campaign fields as sign-in parameters", () => {
    const params = new URLSearchParams({
      utm_source: "github",
      utm_medium: "referral",
      utm_campaign: "github-navigation",
      utm_content: "org-profile-cloud-en",
      utm_term: "agent debugging",
      token: "private-token",
      callbackUrl: "https://evil.example.com",
    });
    const res = proxy(request(`/projects/p1/traces?${params}`));
    const location = new URL(res.headers.get("location")!);

    expect(location.pathname).toBe("/auth/sign-in");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      callbackUrl: `/projects/p1/traces?${params}`,
      utm_source: "github",
      utm_medium: "referral",
      utm_campaign: "github-navigation",
      utm_content: "org-profile-cloud-en",
      utm_term: "agent debugging",
    });
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
    const doubleSlash = new NextRequest(
      "http://localhost:3000//evil.example/onboarding?callbackUrl=%2Fdevice",
    );
    const dotSegment = new NextRequest("http://localhost:3000/..//evil.example?user_code=ABCD1234");
    expect(callback(proxy(doubleSlash))).toBe("/");
    expect(callback(proxy(dotSegment))).toBe("/");
  });
});

describe("campaign attribution at the proxy entry", () => {
  const capturedAt = new Date("2026-10-14T06:00:00Z").getTime();
  const utm = {
    utm_source: "github",
    utm_medium: "referral",
    utm_campaign: "github-navigation",
    utm_content: "org-profile-cloud-en",
    utm_term: "agent debugging",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(capturedAt);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://analytics.example.com");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(["/auth/sign-in", "/auth/sign-up"])(
    "captures all five campaign fields on a direct visit to %s",
    (path) => {
      const res = proxy(
        request(`${path}?${new URLSearchParams(utm)}`, { origin: "https://cloud.example.com" }),
      );
      const cookie = res.cookies.get(ATTRIBUTION_COOKIE)!;

      expect(res.headers.get("location")).toBeNull();
      const policy = res.headers.get("content-security-policy");
      const nonce = forwarded(res, "x-nonce");
      expect(nonce).toBeTruthy();
      expect(policy).toContain(`'nonce-${nonce}'`);
      expect(forwarded(res, "content-security-policy")).toBe(policy);
      expect(res.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
      expect(JSON.parse(cookie.value)).toEqual({ v: 1, capturedAt, utm });
      expect(readAttributionCookie(res.headers.get("set-cookie"), capturedAt)).toEqual({
        capturedAt,
        utm,
      });
      expect(cookie).toMatchObject({
        path: "/",
        sameSite: "lax",
        secure: true,
        maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
      });
      expect(cookie.domain).toBeUndefined();
      expect(res.headers.get("set-cookie")).not.toMatch(/Domain=/i);
    },
  );

  it("refreshes a tagged redirect but preserves attribution on untagged sign-up navigation", () => {
    const landing = proxy(
      request(`/projects/p1/traces?${new URLSearchParams({ ...utm, token: "private-token" })}`),
    );
    const location = new URL(landing.headers.get("location")!);
    const cookie = landing.cookies.get(ATTRIBUTION_COOKIE)!;
    // Use the encoded wire value a browser stores, not Next's in-memory value.
    const cookieHeader = landing.headers.get("set-cookie")!.split(";")[0];
    const expires = Number(cookie.expires);

    expect(landing.status).toBe(307);
    expect(landing.headers.get("content-security-policy")).toBeNull();
    expect(location.pathname).toBe("/auth/sign-in");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      callbackUrl: `/projects/p1/traces?${new URLSearchParams({ ...utm, token: "private-token" })}`,
      ...utm,
    });
    expect(JSON.parse(cookie.value)).toEqual({ v: 1, capturedAt, utm });
    expect(readAttributionCookie(cookieHeader, capturedAt)).toEqual({ capturedAt, utm });
    expect(expires).toBe(capturedAt + ATTRIBUTION_MAX_AGE_SECONDS * 1000);

    vi.setSystemTime(capturedAt + 1000);
    const signIn = proxy(request(location.toString(), { cookies: cookieHeader }));
    expect(signIn.headers.get("location")).toBeNull();
    expect(signIn.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    const updatedCookieHeader = signIn.headers.get("set-cookie")!.split(";")[0];
    expect(readAttributionCookie(updatedCookieHeader, capturedAt + 1000)).toEqual({
      capturedAt: capturedAt + 1000,
      utm,
    });

    vi.setSystemTime(capturedAt + 120_000);
    const signUp = proxy(request("/auth/sign-up", { cookies: updatedCookieHeader }));
    expect(signUp.headers.get("location")).toBeNull();
    expect(signUp.headers.get("set-cookie")).toBeNull();
    expect(readAttributionCookie(updatedCookieHeader, capturedAt + 120_000)).toEqual({
      capturedAt: capturedAt + 1000,
      utm,
    });
  });

  it.each(["/projects/p1/traces", "/auth/sign-in", "/auth/sign-up"])(
    "refreshes the same campaign on a return visit to %s after 29 days",
    (path) => {
      const first = proxy(request(`${path}?${new URLSearchParams(utm)}`));
      const cookieHeader = first.headers.get("set-cookie")!.split(";")[0];
      const returnedAt = capturedAt + 29 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(returnedAt);

      const second = proxy(
        request(`${path}?${new URLSearchParams(utm)}`, {
          cookies: cookieHeader,
        }),
      );

      expect(readAttributionCookie(second.headers.get("set-cookie"), returnedAt)).toEqual({
        capturedAt: returnedAt,
        utm,
      });
      const refreshed = second.cookies.get(ATTRIBUTION_COOKIE)!;
      expect(refreshed.maxAge).toBe(ATTRIBUTION_MAX_AGE_SECONDS);
      expect(Number(refreshed.expires)).toBe(returnedAt + ATTRIBUTION_MAX_AGE_SECONDS * 1000);
    },
  );

  it("replaces attribution for a changed campaign without retaining fields from the old one", () => {
    const first = proxy(request(`/auth/sign-in?${new URLSearchParams(utm)}`));
    const cookieHeader = first.headers.get("set-cookie")!.split(";")[0];
    vi.setSystemTime(capturedAt + 60_000);

    const second = proxy(
      request("/auth/sign-in?utm_source=newsletter&utm_campaign=product-update", {
        cookies: cookieHeader,
      }),
    );

    expect(JSON.parse(second.cookies.get(ATTRIBUTION_COOKIE)!.value)).toEqual({
      v: 1,
      capturedAt: capturedAt + 60_000,
      utm: { utm_source: "newsletter", utm_campaign: "product-update" },
    });
  });

  it("ignores empty or invalid tags without deleting a prior campaign", () => {
    const first = proxy(request(`/auth/sign-in?${new URLSearchParams(utm)}`));
    const cookieHeader = first.headers.get("set-cookie")!.split(";")[0];
    const params = new URLSearchParams({
      utm_source: "  ",
      utm_medium: "x".repeat(201),
      utm_campaign: "bad\nvalue",
    });

    const second = proxy(request(`/auth/sign-up?${params}`, { cookies: cookieHeader }));

    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "does not capture a campaign for an existing session using %s",
    (name) => {
      const res = proxy(
        request(`/projects/p1/traces?${new URLSearchParams(utm)}`, {
          cookies: `${name}=a-token`,
        }),
      );
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );

  it("does not write attribution on POST requests", () => {
    const res = proxy(request(`/auth/sign-up?${new URLSearchParams(utm)}`, { method: "POST" }));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST"])(
    "does not write attribution when %s is missing",
    (name) => {
      vi.stubEnv(name, "");
      const res = proxy(request(`/auth/sign-in?${new URLSearchParams(utm)}`));
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );

  it("allows local HTTP cookies without the Secure attribute", () => {
    const res = proxy(request("/auth/sign-in?utm_source=github"));
    expect(res.cookies.get(ATTRIBUTION_COOKIE)?.secure).toBe(false);
    expect(res.headers.get("set-cookie")).not.toMatch(/; Secure/i);
  });

  it("round-trips percent signs, separators and Unicode through the actual cookie header", () => {
    const campaign = { utm_source: "newsletter", utm_campaign: "50% launch; 测试" };
    const url = `/auth/sign-in?${new URLSearchParams(campaign)}`;
    const first = proxy(request(url));
    const cookieHeader = first.headers.get("set-cookie")!.split(";")[0];

    expect(readAttributionCookie(cookieHeader, capturedAt)).toEqual({ capturedAt, utm: campaign });
    vi.setSystemTime(capturedAt + 60_000);
    const second = proxy(request(url, { cookies: cookieHeader }));
    expect(readAttributionCookie(second.headers.get("set-cookie"), capturedAt + 60_000)).toEqual({
      capturedAt: capturedAt + 60_000,
      utm: campaign,
    });
  });

  it("does not emit an oversized cookie when bounded values expand during Unicode encoding", () => {
    const params = new URLSearchParams(
      Object.fromEntries(Object.keys(utm).map((key) => [key, "测".repeat(200)])),
    );
    expect(encodeURIComponent(JSON.stringify(Object.fromEntries(params))).length).toBeGreaterThan(
      ATTRIBUTION_MAX_COOKIE_LENGTH,
    );

    const res = proxy(request(`/auth/sign-in?${params}`));
    expect(res.headers.get("set-cookie")).toBeNull();
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
    const res = proxy(request("/auth/sign-in", { origin: "https://localhost:3000" }));
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
