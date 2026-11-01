import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { ATTRIBUTION_COOKIE, ATTRIBUTION_MAX_AGE_SECONDS } from "@/lib/marketing-attribution";
import { signupAttributionProperties } from "./attribution";

const baseURL = "http://localhost:3000";
const capturedAt = Date.now();
const utm = { utm_source: "github", utm_medium: "referral", utm_campaign: "github-navigation" };
let campaignCookie: string;
const expected = {
  ...utm,
  marketing_touch_at: new Date(capturedAt).toISOString(),
  marketing_attribution_model: "last_campaign_touch",
};

function testAuth() {
  const created = vi.fn();
  const auth = betterAuth({
    baseURL,
    secret: "local-test-secret-012345678901234567890123",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    socialProviders: { google: { clientId: "test-client", clientSecret: "test-secret" } },
    plugins: [admin()],
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            created({
              email: user.email,
              path: context?.path,
              provider: context?.params?.id,
              cookie: context?.headers?.get("cookie"),
              properties: signupAttributionProperties(context),
            });
          },
        },
      },
    },
  });
  return { auth, created };
}

function request(path: string, body?: Record<string, unknown>, cookie = campaignCookie) {
  return new Request(`${baseURL}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin: baseURL, cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function responseCookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
}

beforeEach(() => {
  // No real Google, PostHog, or other network calls belong in this test.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://analytics.example.com");
  vi.spyOn(Date, "now").mockReturnValue(capturedAt);
  const landing = proxy(new NextRequest(`${baseURL}/?${new URLSearchParams(utm)}`));
  // Carry the actual HTTP Set-Cookie value, including Next.js serialization,
  // through both registration paths rather than constructing a cookie fixture.
  campaignCookie = responseCookies(landing).join("; ");
  expect(campaignCookie).toContain("traceroot_campaign_v1=");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("campaign attribution through real better-auth handlers", () => {
  it("attributes day-31 signup to a repeat campaign click on day 29", async () => {
    const day = 24 * 60 * 60 * 1000;
    const returnedAt = capturedAt + 29 * day;
    vi.mocked(Date.now).mockReturnValue(returnedAt);
    const returning = proxy(
      new NextRequest(`${baseURL}/?${new URLSearchParams(utm)}`, {
        headers: { cookie: campaignCookie },
      }),
    );
    const renewed = returning.cookies.get(ATTRIBUTION_COOKIE);
    expect(renewed).toBeDefined();
    expect(renewed?.maxAge).toBe(ATTRIBUTION_MAX_AGE_SECONDS);
    expect(JSON.parse(renewed!.value)).toEqual({ v: 1, capturedAt: returnedAt, utm });
    const redirected = proxy(
      new NextRequest(returning.headers.get("location")!, {
        headers: { cookie: responseCookies(returning).join("; ") },
      }),
    );
    campaignCookie = responseCookies(redirected).join("; ");

    vi.mocked(Date.now).mockReturnValue(capturedAt + 31 * day);
    const { auth, created } = testAuth();
    const response = await auth.handler(
      request("/sign-up/email", {
        email: "returning@example.com",
        name: "Returning Visitor",
        password: "test-password-123",
      }),
    );
    expect(response.status).toBe(200);
    expect(created).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        properties: { ...expected, marketing_touch_at: new Date(returnedAt).toISOString() },
      }),
    );
  });

  it("reads request headers from the email signup database hook", async () => {
    const { auth, created } = testAuth();
    const response = await auth.handler(
      request("/sign-up/email", {
        email: "email-test@example.com",
        name: "Email Test",
        password: "test-password-123",
      }),
    );
    expect(response.status).toBe(200);
    expect(created).toHaveBeenCalledExactlyOnceWith({
      email: "email-test@example.com",
      path: "/sign-up/email",
      provider: undefined,
      cookie: campaignCookie,
      properties: expected,
    });
  });

  it("retains the campaign through the Google OAuth callback and user creation", async () => {
    const { auth, created } = testAuth();
    const context = await auth.$context;
    const google = context.socialProviders.find((provider) => provider.id === "google")!;
    // Only Google's token exchange and profile response are replaced. State
    // validation, account creation, and database hooks run in better-auth.
    google.validateAuthorizationCode = vi.fn().mockResolvedValue({ accessToken: "test-token" });
    google.getUserInfo = vi.fn().mockResolvedValue({
      user: {
        id: "google-user",
        name: "Google Test",
        email: "google@example.com",
        emailVerified: true,
      },
      data: {},
    });
    const start = await auth.handler(
      request("/sign-in/social", { provider: "google", callbackURL: `${baseURL}/onboarding` }),
    );
    expect(start.status).toBe(200);
    const { url } = await start.json();
    const state = new URL(url).searchParams.get("state")!;
    const cookie = [campaignCookie, ...responseCookies(start)].join("; ");
    const response = await auth.handler(
      request(
        `/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
        undefined,
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${baseURL}/onboarding`);
    expect(created).toHaveBeenCalledExactlyOnceWith({
      email: "google@example.com",
      path: "/callback/:id",
      provider: "google",
      cookie,
      properties: expected,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "traceroot_campaign_v1=not-json"])(
    "still registers successfully with an absent or invalid campaign cookie: %s",
    async (cookie) => {
      const { auth, created } = testAuth();
      const response = await auth.handler(
        request(
          "/sign-up/email",
          { email: "new@example.com", name: "Test", password: "password-123" },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      expect(created).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ properties: {} }));
    },
  );

  it("does not attribute a staff member's campaign to an account they provision", async () => {
    const { auth, created } = testAuth();
    await auth.api.createUser({
      body: { email: "staff@example.com", name: "Staff", password: "password-123", role: "admin" },
    });
    const login = await auth.handler(
      request("/sign-in/email", { email: "staff@example.com", password: "password-123" }),
    );
    expect(login.status).toBe(200);
    created.mockClear();
    const cookie = [campaignCookie, ...responseCookies(login)].join("; ");
    const response = await auth.handler(
      request("/admin/create-user", { email: "customer@example.com", name: "Customer" }, cookie),
    );
    expect(response.status).toBe(200);
    expect(created).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        email: "customer@example.com",
        path: "/admin/create-user",
        cookie,
        properties: {},
      }),
    );
  });
});
