import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub sign-in through the real better-auth handlers, with this app's own
 * options from auth.ts (social providers, account linking, error page, sign-up
 * hooks). Only the network is stood in for: github.com's token exchange and
 * the profile and email endpoints its provider reads.
 */

const optionsSeen = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth: (options: Record<string, unknown>) => {
    optionsSeen.push(options);
    return { options, $Infer: { Session: {} } };
  },
}));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  genericOAuth: () => ({ id: "generic-oauth" }),
  jwt: () => ({ id: "jwt" }),
}));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
const hooks = vi.hoisted(() => ({
  onUserCreated: vi.fn(async () => undefined),
  captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/signup/on-user-created", () => ({ onUserCreated: hooks.onUserCreated }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: hooks.captureServerEvent }));
vi.mock("@/lib/demo-workspace", () => ({ ensureDemoMembership: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => false }));
const settings = vi.hoisted(() => ({ githubId: " github-client-id ", githubSecret: " secret " }));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "github-sign-in-test-secret-0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    get AUTH_GITHUB_CLIENT_ID() {
      return settings.githubId;
    },
    get AUTH_GITHUB_CLIENT_SECRET() {
      return settings.githubSecret;
    },
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    AUTH_AGENTID_CLIENT_ID: "",
    AUTH_AGENTID_CLIENT_SECRET: "",
    AUTH_TRUSTED_PROXY_CIDRS: "",
  },
}));

const { betterAuth } = await vi.importActual<typeof import("better-auth")>("better-auth");
const BASE = "http://localhost:3000";

/** The app's options from auth.ts, with these GitHub settings. */
async function appOptions(githubId: string, githubSecret = " secret ") {
  settings.githubId = githubId;
  settings.githubSecret = githubSecret;
  optionsSeen.length = 0;
  vi.resetModules();
  await import("./auth");
  return optionsSeen[0] as Record<string, unknown>;
}

async function createAuth(githubId = " github-client-id ") {
  const options = await appOptions(githubId);
  const db: Record<string, unknown[]> = { user: [], account: [], session: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "github-sign-in-test-secret-0123456789",
    baseURL: BASE,
    emailAndPassword: { enabled: true },
    socialProviders: options.socialProviders as never,
    account: options.account as never,
    onAPIError: options.onAPIError as never,
    databaseHooks: options.databaseHooks as never,
    // better-auth skips its origin and callback checks under a test runner;
    // they are on in production, so they are on here too.
    advanced: { disableOriginCheck: false },
  });
  return { auth, db };
}
type Auth = Awaited<ReturnType<typeof createAuth>>["auth"];

/** No test here may reach a real host: a request nothing stands in for fails. */
function offline() {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    throw new Error(
      `unexpected request to ${String(input instanceof Request ? input.url : input)}`,
    );
  });
}

/** github.com as its provider sees it, for one GitHub user. */
function github(user: { id: number; email: string; verified?: boolean }) {
  const json = (body: unknown) => Response.json(body);
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return Promise.resolve(json({ access_token: "gho_test", token_type: "bearer" }));
    if (url === "https://api.github.com/user")
      return Promise.resolve(
        json({ id: user.id, login: `u${user.id}`, name: "Kai Lee", email: user.email }),
      );
    if (url === "https://api.github.com/user/emails")
      return Promise.resolve(
        json([{ email: user.email, primary: true, verified: user.verified ?? true }]),
      );
    // Nothing else may leave the test: any other request fails here.
    throw new Error(`unexpected request to ${url}`);
  });
}

async function start(auth: Auth, callbackURL: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL }),
    }),
  );
}

/** One whole GitHub sign-in; answers where the callback sends the browser. */
async function signIn(auth: Auth, callbackURL = "/onboarding") {
  const started = await start(auth, callbackURL);
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const cookie = started.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const state = new URL(url).searchParams.get("state");
  const callback = await auth.handler(
    new Request(`${BASE}/api/auth/callback/github?state=${state}&code=test-code`, {
      headers: { cookie },
    }),
  );
  return {
    location: callback.headers.get("location"),
    session: callback.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token")),
  };
}

beforeEach(() => {
  offline();
  hooks.onUserCreated.mockClear();
  hooks.captureServerEvent.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub sign-in, configured", () => {
  it("sends the browser to GitHub for the profile and email only, back to this app", async () => {
    const { auth } = await createAuth();
    const started = await start(auth, "/onboarding");
    const url = new URL(((await started.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    // Trimmed, as configured with stray spaces.
    expect(url.searchParams.get("client_id")).toBe("github-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
    // Signing in never asks for repository access; connecting a repository is
    // the GitHub App's, separately.
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["read:user", "user:email"]);
  });

  it("a first sign-in creates the account and hands it to the sign-up follow-up as a GitHub sign-up", async () => {
    const { auth, db } = await createAuth();
    github({ id: 101, email: "kai@acme.test" });
    expect(await signIn(auth)).toEqual({ location: "/onboarding", session: true });
    expect(db.user).toHaveLength(1);
    expect((db.account as { providerId: string }[]).map((a) => a.providerId)).toEqual(["github"]);
    expect(hooks.onUserCreated).toHaveBeenCalledTimes(1);
    expect(hooks.onUserCreated).toHaveBeenCalledWith(
      expect.objectContaining({ email: "kai@acme.test", name: "Kai Lee" }),
      { path: "/callback/:id", provider: "github" },
    );
    expect(hooks.captureServerEvent).toHaveBeenCalledWith(
      expect.any(String),
      "user_signed_up",
      expect.anything(),
    );
  });

  it("refuses a first sign-in whose email GitHub has not verified, and creates nothing", async () => {
    const { auth, db } = await createAuth();
    github({ id: 303, email: "someone-else@acme.test", verified: false });
    const result = await signIn(auth);
    expect(result.session).toBe(false);
    expect(result.location).toMatch(
      /^http:\/\/localhost:3000\/auth\/error\?error=email_not_verified&/,
    );
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
    expect(hooks.onUserCreated).not.toHaveBeenCalled();
  });

  it("signing in again is the same account, with no second sign-up", async () => {
    const { auth, db } = await createAuth();
    github({ id: 101, email: "kai@acme.test" });
    await signIn(auth);
    const again = await signIn(auth, "/projects");
    expect(again).toEqual({ location: "/projects", session: true });
    expect(db.user).toHaveLength(1);
    expect(db.account).toHaveLength(1);
    expect(db.session).toHaveLength(2);
    expect(hooks.onUserCreated).toHaveBeenCalledTimes(1);
  });

  it("a sign-in started from the terminal returns to the device page it came from", async () => {
    const { auth } = await createAuth();
    github({ id: 202, email: "cli@acme.test" });
    const device = "/device?user_code=ABCD1234";
    expect(await signIn(auth, device)).toEqual({ location: device, session: true });
  });

  it("refuses to return anywhere outside this app", async () => {
    const { auth } = await createAuth();
    const started = await start(auth, "https://evil.example/steal");
    expect(started.status).toBe(403);
  });

  it("a failed callback lands on the app's error page", async () => {
    const { auth } = await createAuth();
    const callback = await auth.handler(
      new Request(`${BASE}/api/auth/callback/github?state=forged&code=x`),
    );
    expect(callback.headers.get("location")).toMatch(
      /^http:\/\/localhost:3000\/auth\/error\?error=/,
    );
  });
});

describe("GitHub sign-in, not configured", () => {
  it.each([
    ["no client id", ""],
    ["a client id of spaces", "   "],
  ])("with %s, the provider is not registered and a sign-in cannot start", async (_case, id) => {
    const options = await appOptions(id);
    expect(Object.keys(options.socialProviders as object)).not.toContain("github");
    const { auth } = await createAuth(id);
    const started = await start(auth, "/onboarding");
    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await started.json())).toMatch(/not found/i);
  });
});
