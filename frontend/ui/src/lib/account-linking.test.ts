import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Runs the real better-auth OAuth callback against this app's own
 * `account.accountLinking` options, with an in-memory store and a stubbed
 * GitHub API, and asserts which sign-ins are allowed to attach a social
 * identity to an account that already exists.
 *
 * These are characterization tests over a library policy, not over our code, so
 * they drive the HTTP handlers rather than inspecting the config: whether a
 * provider is "trusted" only shows up as a branch deep inside better-auth's
 * callback, and every wrong answer here is a silent account takeover rather
 * than a failure anyone would notice in review. The config comes from auth.ts
 * so that re-adding a provider to trustedProviders fails here, not in
 * production.
 */

const betterAuthMock = vi.hoisted(() =>
  vi.fn((options: Record<string, unknown>) => ({ options, $Infer: { Session: {} } })),
);

vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth: (o: Record<string, unknown>) => betterAuthMock(o),
}));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  jwt: () => ({ id: "jwt" }),
}));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    AUTH_GITHUB_CLIENT_ID: "",
    AUTH_GITHUB_CLIENT_SECRET: "",
    AUTH_TRUSTED_PROXY_CIDRS: "",
  },
}));

await import("./auth");
const appAccountOptions = (
  betterAuthMock.mock.calls[0]?.[0] as {
    account: Record<string, unknown>;
  }
).account;

const { betterAuth } = await vi.importActual<typeof import("better-auth")>("better-auth");

const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct-horse-battery";

type GithubIdentity = { id: string; email: string; emailVerified: boolean };

/**
 * Answers the two github.com endpoints better-auth's built-in provider calls
 * during the callback: the token exchange, and the profile plus email list it
 * derives `emailVerified` from. Everything else falls through, so an
 * unexpected outbound call surfaces as a failure instead of being swallowed.
 */
function stubGithubApi(identity: GithubIdentity) {
  const realFetch = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Promise.resolve(
        json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" }),
      );
    }
    if (url === "https://api.github.com/user") {
      return Promise.resolve(
        json({
          id: identity.id,
          login: `user-${identity.id}`,
          name: `User ${identity.id}`,
          email: identity.email,
          avatar_url: "https://example.invalid/avatar.png",
        }),
      );
    }
    if (url === "https://api.github.com/user/emails") {
      return Promise.resolve(
        json([
          {
            email: identity.email,
            primary: true,
            verified: identity.emailVerified,
            visibility: "public",
          },
        ]),
      );
    }
    return realFetch(input, init);
  });
}

function createAuth() {
  const db: Record<string, unknown[]> = { user: [], account: [], session: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "account-linking-test-secret",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    // Credentials are blank in the env mock, so the provider is registered here
    // directly; what is under test is the linking policy, not the credential
    // gating (social-auth.test.ts covers that).
    socialProviders: { github: { clientId: "test-id", clientSecret: "test-secret" } },
    ...(appAccountOptions ? { account: appAccountOptions } : {}),
  });
  return { auth, db };
}

type AuthInstance = ReturnType<typeof createAuth>["auth"];

async function signUpWithPassword(auth: AuthInstance, email: string) {
  const res = await auth.handler(
    new Request(`${BASE}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Existing User" }),
    }),
  );
  expect(res.status).toBe(200);
}

/**
 * A password sign-up leaves `emailVerified` false — this app has no local
 * verification flow — so the row is promoted here to stand in for one created
 * by a social sign-up, which is how a verified row actually comes about.
 */
async function markEmailVerified(auth: AuthInstance, email: string) {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  await ctx.internalAdapter.updateUser(found!.user.id, { emailVerified: true });
}

async function signInWithGithub(auth: AuthInstance, identity: GithubIdentity) {
  stubGithubApi(identity);

  const start = await auth.handler(
    new Request(`${BASE}/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
    }),
  );
  const { url } = (await start.json()) as { url: string };
  const cookie = (start.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const state = new URL(url).searchParams.get("state");

  const callback = await auth.handler(
    new Request(`${BASE}/callback/github?state=${state}&code=test-code`, {
      headers: cookie ? { cookie } : {},
    }),
  );
  return {
    location: callback.headers.get("location"),
    signedIn: (callback.headers.getSetCookie?.() ?? []).some((c) =>
      c.startsWith("better-auth.session_token"),
    ),
  };
}

function githubAccountsIn(db: Record<string, unknown[]>) {
  return (db.account as { providerId: string }[]).filter((a) => a.providerId === "github");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub sign-in for an email that already has an account", () => {
  it("refuses to link when GitHub reports the address as unverified", async () => {
    // The takeover: an attacker adds the victim's address to their own GitHub
    // account without confirming it, then signs in. If "github" were a trusted
    // provider better-auth would skip the emailVerified check on the incoming
    // profile, link the attacker's GitHub identity into the victim's row, and
    // hand the attacker a session as the victim.
    const { auth, db } = createAuth();
    await signUpWithPassword(auth, "victim@example.com");
    await markEmailVerified(auth, "victim@example.com");

    const result = await signInWithGithub(auth, {
      id: "attacker-gh-id",
      email: "victim@example.com",
      emailVerified: false,
    });

    expect(result.location).toContain("error=account_not_linked");
    expect(result.signedIn).toBe(false);
    expect(githubAccountsIn(db)).toHaveLength(0);
  });

  it("still links when GitHub reports the address as verified", async () => {
    // The other half: untrusting GitHub must not cost the legitimate user
    // anything. Turning linking off wholesale, or setting
    // disableImplicitLinking, would pass the test above and break this one.
    const { auth, db } = createAuth();
    await signUpWithPassword(auth, "owner@example.com");
    await markEmailVerified(auth, "owner@example.com");

    const result = await signInWithGithub(auth, {
      id: "owner-gh-id",
      email: "owner@example.com",
      emailVerified: true,
    });

    expect(result.location).toBe("/dashboard");
    expect(result.signedIn).toBe(true);
    expect(githubAccountsIn(db)).toHaveLength(1);
  });

  it("refuses to link into an account whose own email was never verified", async () => {
    // Pre-registration takeover, the other ordering: an attacker signs up with
    // a password at an address they do not own, and the real owner later signs
    // in with GitHub. Linking there would drop the owner into a row whose
    // password the attacker chose. better-auth blocks it via
    // accountLinking.requireLocalEmailVerified, which defaults to true —
    // setting it false would fail here.
    const { auth, db } = createAuth();
    await signUpWithPassword(auth, "claimed@example.com");

    const result = await signInWithGithub(auth, {
      id: "real-owner-gh-id",
      email: "claimed@example.com",
      emailVerified: true,
    });

    expect(result.location).toContain("error=account_not_linked");
    expect(result.signedIn).toBe(false);
    expect(githubAccountsIn(db)).toHaveLength(0);
  });
});

describe("GitHub sign-in for a new email", () => {
  it("creates the account even when GitHub reports the address as unverified", async () => {
    // Untrusting GitHub only affects linking into an existing row; a first-time
    // sign-in must still work, or the provider is unusable for anyone whose
    // GitHub address is unconfirmed.
    const { auth, db } = createAuth();

    const result = await signInWithGithub(auth, {
      id: "newcomer-gh-id",
      email: "newcomer@example.com",
      emailVerified: false,
    });

    expect(result.location).toBe("/dashboard");
    expect(result.signedIn).toBe(true);
    expect(githubAccountsIn(db)).toHaveLength(1);
    expect(db.user).toHaveLength(1);
  });
});

describe("password sign-up for an email that already has a GitHub account", () => {
  it("is rejected rather than merged", async () => {
    const { auth, db } = createAuth();
    await signInWithGithub(auth, {
      id: "owner-gh-id",
      email: "owner@example.com",
      emailVerified: true,
    });

    const res = await auth.handler(
      new Request(`${BASE}/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner@example.com",
          password: PASSWORD,
          name: "Attacker",
        }),
      }),
    );

    expect(res.status).toBe(422);
    expect(db.user).toHaveLength(1);
    expect((db.account as { providerId: string }[]).map((a) => a.providerId)).toEqual(["github"]);
  });
});
