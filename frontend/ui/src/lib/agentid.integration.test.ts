import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth } from "better-auth/plugins";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { AGENTID_ENDPOINTS, AGENTID_ISSUER, agentIdProvider } from "./agentid";

// Real better-auth handlers and the real AgentID provider; only the network is
// faked: fetch serves AgentID's token, userinfo and JWKS, and Google is stubbed.

const baseURL = "http://localhost:3000";
const CLIENT_ID = "agentid-test-client";
const CLIENT_SECRET = "agentid-test-secret";
const KID = "agentid-test-key";

type Row = Record<string, unknown>;
type Db = { user: Row[]; session: Row[]; account: Row[]; verification: Row[] };

let db: Db;
let agentKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: Row;
let idTokenFor: () => Promise<string | undefined>;
let userinfo: Row;
let googleProfile: { sub: string; email: string };
let tokenRequests: { authorization: string | null; body: URLSearchParams }[];
let createdWith: { path?: string; provider?: string }[];

beforeAll(async () => {
  const agent = await generateKeyPair("ES256", { extractable: true });
  agentKey = agent.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  publicJwk = { ...(await exportJWK(agent.publicKey)), kid: KID, alg: "ES256", use: "sig" };
});

function idToken(
  claims: Row = {},
  { key = agentKey, expiresIn = "10m" }: { key?: CryptoKey; expiresIn?: string | number } = {},
) {
  return new SignJWT({ email: userinfo.email, email_verified: true, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer((claims.iss as string) ?? AGENTID_ISSUER)
    .setAudience((claims.aud as string) ?? CLIENT_ID)
    .setSubject((claims.sub as string) ?? (userinfo.sub as string))
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/** The agent the fake AgentID signs in next. */
function agent(sub: string, email = `${sub}@agentmail.to`, ownerSub: string | null = "owner-a") {
  userinfo = { sub, email, email_verified: true, name: "Agent" };
  if (ownerSub) userinfo.owner_sub = ownerSub;
}

async function testAuth() {
  db = { user: [], session: [], account: [], verification: [] };
  createdWith = [];
  const auth = betterAuth({
    baseURL,
    secret: "local-test-secret-012345678901234567890123",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    socialProviders: { google: { clientId: "test-client", clientSecret: "test-secret" } },
    account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },
    onAPIError: { errorURL: `${baseURL}/auth/error` },
    databaseHooks: {
      user: {
        create: {
          after: async (_user, context) => {
            createdWith.push({ path: context?.path, provider: context?.params?.id });
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          agentIdProvider({
            AUTH_AGENTID_CLIENT_ID: CLIENT_ID,
            AUTH_AGENTID_CLIENT_SECRET: CLIENT_SECRET,
          }),
        ],
      }),
    ],
  });
  const google = (await auth.$context).socialProviders.find((p) => p.id === "google")!;
  google.validateAuthorizationCode = vi.fn().mockResolvedValue({ accessToken: "google-token" });
  google.getUserInfo = vi.fn(async () => ({
    user: { name: "Human", email: googleProfile.email, emailVerified: true },
    data: { sub: googleProfile.sub },
  }));
  return auth;
}

function fakeAgentId() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === AGENTID_ENDPOINTS.jwksUrl) return Response.json({ keys: [publicJwk] });
    if (url === AGENTID_ENDPOINTS.userInfoUrl) return Response.json(userinfo);
    if (url === AGENTID_ENDPOINTS.tokenUrl) {
      tokenRequests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return Response.json({
        access_token: "agent-access-token",
        token_type: "Bearer",
        expires_in: 600,
        id_token: await idTokenFor(),
      });
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
}

function request(path: string, body?: Row, cookie = "") {
  return new Request(`${baseURL}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin: baseURL, cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** One full social sign-in; returns the authorize URL and where the callback redirects. */
async function signIn(auth: Awaited<ReturnType<typeof testAuth>>, provider: "agentid" | "google") {
  const start = await auth.handler(
    request("/sign-in/social", { provider, callbackURL: `${baseURL}/onboarding` }),
  );
  expect(start.status).toBe(200);
  const authorizeUrl = new URL(((await start.json()) as { url: string }).url);
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const state = encodeURIComponent(authorizeUrl.searchParams.get("state")!);
  const response = await auth.handler(
    request(`/callback/${provider}?code=test-code&state=${state}`, undefined, cookie),
  );
  expect(response.status).toBe(302);
  return { authorizeUrl, location: response.headers.get("location") ?? "" };
}

/** The `error` code if the redirect is the app's /auth/error page, else null. */
function errorCode(location: string) {
  const url = new URL(location);
  return url.pathname === "/auth/error" ? url.searchParams.get("error") : null;
}
const accountsFor = (providerId: string) => db.account.filter((a) => a.providerId === providerId);
const userByEmail = (email: string) => db.user.find((u) => u.email === email);

beforeEach(() => {
  tokenRequests = [];
  agent("agent-1");
  idTokenFor = () => idToken();
  vi.stubGlobal("fetch", fakeAgentId());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AgentID sign-in", () => {
  it("creates a new agent user keyed on sub, never trusting AgentID's verified email", async () => {
    const auth = await testAuth();
    const { authorizeUrl, location } = await signIn(auth, "agentid");

    expect(location).toBe(`${baseURL}/onboarding`);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      AGENTID_ENDPOINTS.authorizationUrl,
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(db.user).toEqual([
      expect.objectContaining({ email: "agent-1@agentmail.to", emailVerified: false }),
    ]);
    expect(accountsFor("agentid")).toEqual([expect.objectContaining({ accountId: "agent-1" })]);
    expect(createdWith).toEqual([{ path: "/callback/:id", provider: "agentid" }]);

    const [{ authorization, body }] = tokenRequests;
    expect(authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
      authorizeUrl.searchParams.get("code_challenge"),
    );
  });

  it.each([
    ["signed by another key", () => idToken({}, { key: otherKey })],
    ["for another client", () => idToken({ aud: "someone-else" })],
    ["from another issuer", () => idToken({ iss: "https://evil.example" })],
    ["expired", () => idToken({}, { expiresIn: Math.floor(Date.now() / 1000) - 3600 })],
    ["whose subject differs from userinfo", () => idToken({ sub: "someone-else" })],
    ["that is missing", async () => undefined],
  ])("rejects an id_token %s and creates no user", async (_, mint) => {
    idTokenFor = mint;
    const auth = await testAuth();

    expect(errorCode((await signIn(auth, "agentid")).location)).toBeTruthy();
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
  });

  it("builds auth without contacting AgentID, so a hung AgentID cannot stall sign-in", async () => {
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", hang);

    const auth = await testAuth();
    const signUp = await auth.handler(
      request("/sign-up/email", { email: "h@example.com", name: "H", password: "pw-123456" }),
    );

    expect(signUp.status).toBe(200);
    expect(hang).not.toHaveBeenCalled();
  });
});

describe("AgentID never merges into an existing user", () => {
  it("refuses an agent whose email belongs to a Google user, and leaves that user alone", async () => {
    const auth = await testAuth();
    googleProfile = { sub: "google-alice", email: "alice@example.com" };
    await signIn(auth, "google");
    const alice = userByEmail("alice@example.com")!;
    const sessions = db.session.filter((s) => s.userId === alice.id).length;

    agent("agent-alice", "alice@example.com");
    expect(errorCode((await signIn(auth, "agentid")).location)).toBe("account_not_linked");
    expect(accountsFor("agentid")).toHaveLength(0);
    expect(db.user).toHaveLength(1);
    expect(db.session.filter((s) => s.userId === alice.id)).toHaveLength(sessions);
  });

  it("refuses an agent whose email belongs to a verified email-and-password user", async () => {
    const auth = await testAuth();
    await auth.handler(
      request("/sign-up/email", { email: "bob@example.com", name: "Bob", password: "pw-123456" }),
    );
    userByEmail("bob@example.com")!.emailVerified = true;

    agent("agent-bob", "bob@example.com");
    expect(errorCode((await signIn(auth, "agentid")).location)).toBe("account_not_linked");
    expect(accountsFor("agentid")).toHaveLength(0);
  });

  it("signs a returning agent into the same user", async () => {
    const auth = await testAuth();
    await signIn(auth, "agentid");

    expect((await signIn(auth, "agentid")).location).toBe(`${baseURL}/onboarding`);
    expect(db.user).toHaveLength(1);
  });

  it("does not merge a second agent that reuses an address under a different sub", async () => {
    const auth = await testAuth();
    agent("agent-3", "shared@agentmail.to");
    await signIn(auth, "agentid");

    agent("agent-4", "shared@agentmail.to");
    expect(errorCode((await signIn(auth, "agentid")).location)).toBe("account_not_linked");
    expect(accountsFor("agentid").map((a) => a.accountId)).toEqual(["agent-3"]);
  });

  it("does not merge a Google sign-in into an existing agent user", async () => {
    const auth = await testAuth();
    await signIn(auth, "agentid");

    googleProfile = { sub: "google-5", email: "agent-1@agentmail.to" };
    expect(errorCode((await signIn(auth, "google")).location)).toBe("account_not_linked");
    expect(accountsFor("google")).toHaveLength(0);
  });
});
