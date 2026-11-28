import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google sign-in through the app's own auth options (lib/auth.ts), run by the real
 * better-auth handlers on an in-memory database. Only Google itself is faked: its
 * code exchange and profile. auth.test.ts pins the options one by one; this pins
 * what they add up to for the three people the onboarding flow has to serve: a new
 * Google user, a returning one, and someone who started in the CLI.
 */

const baseURL = "https://cloud.example.com";

const database = vi.hoisted(
  (): Record<string, Record<string, unknown>[]> => ({
    user: [],
    session: [],
    account: [],
    verification: [],
    deviceCode: [],
    jwks: [],
  }),
);

vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    ...actual,
    betterAuth: (options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth({ ...options, database: memoryAdapter(database) }),
  };
});
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: vi.fn() }));
const onUserCreated = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/signup/on-user-created", () => ({ onUserCreated }));
const ensureDemoMembership = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/demo-workspace", () => ({ ensureDemoMembership }));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "local-test-secret-012345678901234567890123",
    BETTER_AUTH_URL: "https://cloud.example.com",
    TRACEROOT_CLOUD_ENV: "production",
    AUTH_GOOGLE_CLIENT_ID: "test-client",
    AUTH_GOOGLE_CLIENT_SECRET: "test-secret",
    // Unset, as their defaults leave them: Google is the only social sign-in here.
    AUTH_AGENTID_CLIENT_ID: "",
    AUTH_AGENTID_CLIENT_SECRET: "",
    AUTH_TRUSTED_PROXY_CIDRS: "",
  },
}));

const { auth } = await import("./auth");

type GoogleProfile = { sub: string; email: string; name: string };

function request(path: string, body?: Record<string, unknown>, cookie = "") {
  return new Request(`${baseURL}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin: baseURL, cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function cookiesOf(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!);
}

/** Starts "Continue with Google" with the page's callbackURL and comes back as `profile`. */
async function continueWithGoogle(profile: GoogleProfile, callbackURL: string) {
  const context = await auth.$context;
  const google = context.socialProviders.find((provider) => provider.id === "google")!;
  google.validateAuthorizationCode = vi.fn().mockResolvedValue({ accessToken: "test-token" });
  google.getUserInfo = vi.fn().mockResolvedValue({
    user: { id: profile.sub, name: profile.name, email: profile.email, emailVerified: true },
    data: profile,
  });

  const start = await auth.handler(request("/sign-in/social", { provider: "google", callbackURL }));
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin).toBe("https://accounts.google.com");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);

  const state = authorize.searchParams.get("state")!;
  const callback = await auth.handler(
    request(
      `/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
      undefined,
      cookiesOf(start).join("; "),
    ),
  );
  return {
    status: callback.status,
    location: callback.headers.get("location"),
    sessionCookie: cookiesOf(callback).find((c) => c.includes("session_token=")),
  };
}

const googleAccounts = () => database.account!.filter((a) => a.providerId === "google");

beforeEach(() => {
  // Nothing in these flows may reach the network; Google is faked above.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  for (const rows of Object.values(database)) rows.length = 0;
  onUserCreated.mockClear();
  ensureDemoMembership.mockClear();
});

afterEach(() => {
  // Covers the session hook; signup follow-ups have their own regression test.
  expect(ensureDemoMembership).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const ada: GoogleProfile = { sub: "google-ada", email: "ada@example.co", name: "Ada Lovelace" };

describe("Google sign-in with the app's auth options", () => {
  it("creates a new Google user, signs them in and sends them to onboarding", async () => {
    const result = await continueWithGoogle(ada, "/onboarding");

    expect(result.status).toBe(302);
    expect(result.location).toBe("/onboarding");
    expect(result.sessionCookie).toBeDefined();
    expect(database.user).toHaveLength(1);
    expect(database.user![0]).toMatchObject({ email: ada.email, emailVerified: true });
    expect(googleAccounts()).toEqual([
      expect.objectContaining({ accountId: ada.sub, userId: database.user![0]!.id }),
    ]);
    // The sign-up follow-ups (welcome email, Slack notice) run once, for this account.
    expect(onUserCreated).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("brings a user who started in the CLI back to the device page after onboarding", async () => {
    // What /auth/sign-up hands Google when it was opened from `traceroot login`.
    const fromCli = `/onboarding?callbackUrl=${encodeURIComponent("/device?user_code=ABCD-1234")}`;
    const result = await continueWithGoogle(ada, fromCli);

    expect(result.status).toBe(302);
    expect(result.location).toBe(fromCli);
    expect(result.sessionCookie).toBeDefined();
  });

  it("signs a returning Google user into the same account, without a second sign-up", async () => {
    await continueWithGoogle(ada, "/onboarding");
    const firstUser = database.user![0]!.id;

    const result = await continueWithGoogle(ada, "/");

    expect(result.status).toBe(302);
    expect(result.location).toBe("/");
    expect(result.sessionCookie).toBeDefined();
    expect(database.user).toHaveLength(1);
    expect(googleAccounts()).toHaveLength(1);
    expect(database.session!.filter((s) => s.userId === firstUser)).toHaveLength(2);
    expect(onUserCreated).toHaveBeenCalledOnce();
  });

  it("does not hand an unverified email-and-password account to whoever signs in with Google", async () => {
    // Email sign-ups are not verified, so anyone could have registered this address
    // first. Linking it on a Google sign-in would give that person the victim's
    // account; better-auth refuses unless the local email is verified.
    const signUp = await auth.handler(
      request("/sign-up/email", { email: ada.email, name: "Ada", password: "test-password-123" }),
    );
    expect(signUp.status).toBe(200);
    expect(database.user![0]).toMatchObject({ emailVerified: false });

    const result = await continueWithGoogle(ada, "/");

    expect(result.status).toBe(302);
    expect(new URL(result.location!, baseURL).searchParams.get("error")).toBe("account_not_linked");
    expect(result.sessionCookie).toBeUndefined();
    expect(googleAccounts()).toHaveLength(0);
    expect(database.user).toHaveLength(1);
  });
});
