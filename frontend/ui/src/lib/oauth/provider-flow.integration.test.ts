import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

// The project picker parks its choice in the database; here it is a fixed pick.
const readMock = vi.fn();
vi.mock("@/lib/oauth/project-selection", () => ({
  clearProjectSelection: vi.fn(),
  readProjectSelection: (...args: unknown[]) => readMock(...args),
}));

import { oauthDefaultResource } from "./default-resource";
import { oauthRefreshReuseLog, type RefreshTokenLookup } from "./refresh-reuse-log";
import { mcpOAuthProviderOptions } from "./provider-options";

// Real better-auth handlers with the provider configured as in auth.ts, on an
// in-memory database: registration, authorization, token and refresh behave as
// they do in production, without a server or a network.

const baseURL = "http://localhost:3000";
const RESOURCE = "https://mcp.example.com/mcp";
const SCOPE = "mcp:read offline_access";

function testAuth() {
  const tables = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthClientResource: [],
    oauthResource: [],
    oauthAccessToken: [],
    oauthRefreshToken: [] as Awaited<ReturnType<RefreshTokenLookup>>[],
    oauthConsent: [],
    oauthClientAssertion: [],
  };
  // The reuse log reads the same rows the provider wrote, by their stored form.
  const lookup: RefreshTokenLookup = async (stored) =>
    tables.oauthRefreshToken.find((row) => (row as { token?: string })?.token === stored) ?? null;
  return betterAuth({
    baseURL,
    secret: "local-test-secret-012345678901234567890123",
    database: memoryAdapter(tables),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA" } } }),
      oauthDefaultResource(RESOURCE),
      oauthRefreshReuseLog(lookup),
      oauthProvider(mcpOAuthProviderOptions(RESOURCE)),
    ],
  });
}

// The claims of a JWT access token; an opaque token has none and fails here.
function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
}

type Auth = ReturnType<typeof testAuth>;
let auth: Auth;

function call(
  path: string,
  init: { body?: unknown; form?: Record<string, string>; cookie?: string },
) {
  const headers: Record<string, string> = { origin: baseURL };
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, { method: body ? "POST" : "GET", headers, body }),
  );
}

function register(body: Record<string, unknown>) {
  return call("/oauth2/register", { body });
}

async function signUp(): Promise<string> {
  const response = await call("/sign-up/email", {
    body: { email: "dev@example.com", password: "password-12345", name: "Dev" },
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const REDIRECT_URI = "http://127.0.0.1:7777/callback";

async function registerClient(): Promise<string> {
  const response = await register({
    client_name: "Test assistant",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

// Runs an authorization through the picker and consent and returns the code.
async function authorize(
  clientId: string,
  cookie: string,
  challenge: string,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  const first = await call(`/oauth2/authorize?${params}`, { cookie });
  const picker = new URL(first.headers.get("location") ?? "", baseURL);
  expect(picker.pathname).toBe("/oauth/select-project");

  readMock.mockResolvedValue("p1");
  const continued = await call("/oauth2/continue", {
    cookie,
    body: { postLogin: true, oauth_query: picker.search.slice(1) },
  });
  const consentPage = new URL(((await continued.json()) as { url: string }).url, baseURL);
  expect(consentPage.pathname).toBe("/oauth/consent");

  const consented = await call("/oauth2/consent", {
    cookie,
    body: { accept: true, oauth_query: consentPage.search.slice(1) },
  });
  const callback = new URL(((await consented.json()) as { url: string }).url);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  return code as string;
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

async function token(form: Record<string, string>) {
  const response = await call("/oauth2/token", { form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function connect(
  extra: { authorize?: Record<string, string>; token?: Record<string, string> } = {},
) {
  const cookie = await signUp();
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await authorize(clientId, cookie, challenge, extra.authorize);
  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    ...extra.token,
  });
  return { clientId, exchanged };
}

beforeEach(() => {
  // Only Date is faked, so the refresh reuse window can be stepped over.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  readMock.mockReset();
  auth = testAuth();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dynamic client registration", () => {
  const base = {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  it("registers the Gemini CLI, which sends a localhost callback and no application_type", async () => {
    const response = await register({
      client_name: "Gemini CLI MCP Client",
      redirect_uris: ["http://localhost:7777/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ application_type: "native" });
  });

  it.each([
    ["Cursor (custom scheme)", ["cursor://anysphere.cursor-mcp/oauth/callback"]],
    ["Cursor (web)", ["https://www.cursor.com/agents/mcp/oauth/callback"]],
    ["VS Code", ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"]],
    ["IPv6 loopback", ["http://[::1]:5000/callback"]],
    ["Claude", ["https://claude.ai/api/mcp/auth_callback"]],
    ["ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]],
  ])("registers %s", async (_name, redirect_uris) => {
    const response = await register({ ...base, client_name: _name, redirect_uris });
    expect(response.status).toBe(201);
  });

  it.each([
    ["plain http off loopback", ["http://evil.example/cb"]],
    [
      "plain http off loopback next to a loopback one",
      ["http://localhost:1/cb", "http://evil.example/cb"],
    ],
    ["javascript:", ["javascript:alert(1)"]],
  ])("refuses %s", async (_name, redirect_uris) => {
    const response = await register({ ...base, client_name: _name, redirect_uris });
    expect(response.status).toBe(400);
  });
});

describe("tokens for a request that names no resource", () => {
  it("are JWTs for the MCP server from the code exchange and the refresh", async () => {
    const { clientId, exchanged } = await connect();
    expect(exchanged.status).toBe(200);
    const issued = exchanged.body as TokenResponse;
    expect(decodeJwt(issued.access_token)).toMatchObject({ aud: RESOURCE, project_id: "p1" });

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt((refreshed.body as TokenResponse).access_token)).toMatchObject({
      aud: RESOURCE,
      project_id: "p1",
    });
  });

  it.each(["GET", "POST"])(
    "carry the MCP server through an authorization sent by %s",
    async (method) => {
      const cookie = await signUp();
      const clientId = await registerClient();
      const form = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "s1",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      };
      const response =
        method === "GET"
          ? await call(`/oauth2/authorize?${new URLSearchParams(form)}`, { cookie })
          : await call("/oauth2/authorize", { cookie, form });
      const picker = new URL(response.headers.get("location") ?? "", baseURL);
      expect(picker.pathname).toBe("/oauth/select-project");
      expect(picker.searchParams.getAll("resource")).toEqual([RESOURCE]);
    },
  );

  it("are JWTs for the MCP server when only the token request names it", async () => {
    const { exchanged } = await connect({ token: { resource: RESOURCE } });
    expect(exchanged.status).toBe(200);
    expect(decodeJwt((exchanged.body as TokenResponse).access_token).aud).toBe(RESOURCE);
  });

  it("still refuses a token request for a different resource", async () => {
    const { exchanged } = await connect({ token: { resource: "https://other.example.com/mcp" } });
    expect(exchanged.status).toBe(400);
  });

  it("still refuses an authorization for a different resource", async () => {
    const cookie = await signUp();
    const clientId = await registerClient();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "s1",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: "https://other.example.com/mcp",
    });
    const response = await call(`/oauth2/authorize?${params}`, { cookie });
    const location = new URL(response.headers.get("location") ?? "", baseURL);
    expect(location.pathname).not.toBe("/oauth/select-project");
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });
});

describe("a rotated refresh token", () => {
  async function rotateOnce() {
    const { clientId, exchanged } = await connect();
    const first = (exchanged.body as TokenResponse).refresh_token;
    const form = { grant_type: "refresh_token", refresh_token: first, client_id: clientId };
    const rotated = await token(form);
    expect(rotated.status).toBe(200);
    return { form, rotated: rotated.body as TokenResponse, clientId };
  }

  it("replays the same response when reused within the hour", async () => {
    const { form, rotated } = await rotateOnce();
    vi.advanceTimersByTime(3_599_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replayed = await token(form);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/age_s=3599 within_reuse_window=true$/),
    );
    warn.mockRestore();
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({
      access_token: rotated.access_token,
      refresh_token: rotated.refresh_token,
    });
  });

  it("is treated as stolen when reused after the hour, revoking the newer token too", async () => {
    const { form, rotated, clientId } = await rotateOnce();
    vi.advanceTimersByTime(3_601_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reused = await token(form);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`client_id=${clientId} age_s=3601 within_reuse_window=false$`),
      ),
    );
    warn.mockRestore();
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");

    const successor = await token({
      grant_type: "refresh_token",
      refresh_token: rotated.refresh_token,
      client_id: clientId,
    });
    expect(successor.status).toBe(400);
  });
});
