import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { oauthImpersonationGuard } from "./impersonation-guard";
import {
  mcpOAuthProviderOptions,
  OAUTH_CONSENT_PAGE,
  OAUTH_SELECT_PROJECT_PAGE,
} from "./provider-options";
import { mcpCimdOptions } from "./client-metadata-documents";

// The project the user picked; the picker page itself is not part of this test.
const picked = vi.hoisted(() => ({ projectId: null as string | null }));
vi.mock("@/lib/oauth/project-selection", () => ({
  clearProjectSelection: vi.fn(async () => {}),
  readProjectSelection: vi.fn(async () => picked.projectId),
}));

const baseURL = "http://localhost:3000";
const RESOURCE = "https://mcp.example.com/mcp";
const SCOPE = "mcp:read offline_access";

// The documents the assistants publish, as fetched on 2026-11-11.
const CLAUDE = {
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const CLAUDE_CODE = {
  client_id: "https://claude.ai/oauth/claude-code-client-metadata",
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const CHATGPT = {
  client_id: "https://chatgpt.com/oauth/client.json",
  client_uri: "https://chatgpt.com/",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  client_name: "ChatGPT",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
};
// ChatGPT authenticates at the token endpoint with a key from its jwks_uri.
const chatgptKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CHATGPT_JWKS = {
  keys: [
    { ...chatgptKey.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" },
  ],
};

// Served at a URL that is not its client_id.
const IMPOSTOR_URL = "https://evil.example/claude.json";
const IMPOSTOR = { ...CLAUDE, redirect_uris: ["https://evil.example/callback"] };

const documents: Record<string, object> = {
  [CLAUDE.client_id]: CLAUDE,
  [CLAUDE_CODE.client_id]: CLAUDE_CODE,
  [CHATGPT.client_id]: CHATGPT,
  [CHATGPT.jwks_uri]: CHATGPT_JWKS,
  [IMPOSTOR_URL]: IMPOSTOR,
};

// Stands in for the network transport; the plugin's own checks run unchanged.
const fetchDocument = vi.fn(async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  const document = documents[url];
  if (!document) return new Response("not found", { status: 404 });
  return Response.json(document);
});

function testAuth() {
  return betterAuth({
    baseURL,
    secret: "local-test-secret-012345678901234567890123",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthClient: [],
      oauthClientResource: [],
      oauthResource: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
      oauthClientAssertion: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      oauthImpersonationGuard(),
      oauthProvider(mcpOAuthProviderOptions(RESOURCE)),
      cimd(mcpCimdOptions(fetchDocument)),
    ],
  });
}

let auth: ReturnType<typeof testAuth>;
let cookie: string;

function request(path: string, init: { body?: object; cookie?: string } = {}) {
  return new Request(`${baseURL}/api/auth${path}`, {
    method: init.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r7W1gNXHnJ6MOU";

function authorize(clientId: string, redirectUri: string) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: "state-1",
    code_challenge: createHash("sha256").update(CODE_VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  return auth.handler(request(`/oauth2/authorize?${query}`, { cookie }));
}

// Where an authorization response sends the browser: the project picker when the
// client was accepted, otherwise an error.
function location(response: Response): URL {
  const target = response.headers.get("location");
  expect(target, `status ${response.status}`).toBeTruthy();
  return new URL(target!, baseURL);
}

// An unknown client gets no redirect at all: the error is the response itself.
async function clientError(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
  return (await response.json()).error;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

// A private_key_jwt client assertion (RFC 7523) signed with ChatGPT's test key.
function chatgptAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: CHATGPT.client_id,
      sub: CHATGPT.client_id,
      aud: `${baseURL}/api/auth/oauth2/token`,
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(chatgptKey.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

// Picks a project, consents, and returns the redirect that carries the code.
async function approve(pickerUrl: URL): Promise<URL> {
  picked.projectId = "p1";
  const oauthQuery = pickerUrl.search.slice(1);
  const continued = await auth.handler(
    request("/oauth2/continue", { body: { postLogin: true, oauth_query: oauthQuery }, cookie }),
  );
  expect(continued.status, await continued.clone().text()).toBe(200);
  const consentUrl = new URL((await continued.json()).url, baseURL);
  expect(consentUrl.pathname).toBe(OAUTH_CONSENT_PAGE);
  const consented = await auth.handler(
    request("/oauth2/consent", {
      body: { accept: true, oauth_query: consentUrl.search.slice(1) },
      cookie,
    }),
  );
  expect(consented.status, await consented.clone().text()).toBe(200);
  return new URL((await consented.json()).url);
}

function token(params: Record<string, string>) {
  return auth.handler(
    new Request(`${baseURL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
}

async function storedClient(clientId: string) {
  const ctx = await auth.$context;
  return ctx.adapter.findOne<Record<string, unknown>>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
}

beforeEach(async () => {
  picked.projectId = null;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  fetchDocument.mockClear();
  auth = testAuth();
  const signUp = await auth.handler(
    request("/sign-up/email", {
      body: { email: "dev@example.com", password: "password-1234", name: "Dev" },
    }),
  );
  expect(signUp.status).toBe(200);
  cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client ID metadata documents", () => {
  it("are advertised alongside public clients", async () => {
    const response = await auth.handler(request("/.well-known/oauth-authorization-server"));
    const metadata = await response.json();
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    // Claude only chooses a document over registration when both are present.
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
    expect(metadata.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
    expect(metadata.registration_endpoint).toBeTruthy();
  });

  it.each([
    ["Claude", CLAUDE.client_id, CLAUDE.redirect_uris[0]],
    ["Claude Code", CLAUDE_CODE.client_id, "http://localhost:53123/callback"],
    ["Claude Code on 127.0.0.1", CLAUDE_CODE.client_id, "http://127.0.0.1:61000/callback"],
    ["ChatGPT", CHATGPT.client_id, CHATGPT.redirect_uris[0]],
  ])("let %s start an authorization that reaches the project picker", async (_, id, redirect) => {
    const target = location(await authorize(id, redirect));

    expect(target.pathname).toBe(OAUTH_SELECT_PROJECT_PAGE);
    expect(fetchDocument).toHaveBeenCalledWith(id, expect.anything());
  });

  it("create a client held to the same scopes and resource as a registered one", async () => {
    await authorize(CHATGPT.client_id, CHATGPT.redirect_uris[0]);

    const client = await storedClient(CHATGPT.client_id);
    expect(client).toMatchObject({
      clientDiscoveryId: "cimd",
      name: "ChatGPT",
      tokenEndpointAuthMethod: "private_key_jwt",
      jwksUri: CHATGPT.jwks_uri,
      redirectUris: CHATGPT.redirect_uris,
    });
    expect(client?.clientSecret).toBeFalsy();
    expect(client?.scopes).toEqual(SCOPE.split(" "));
    const ctx = await auth.$context;
    const resources = await ctx.adapter.findMany<{ resourceId: string }>({
      model: "oauthClientResource",
      where: [{ field: "clientId", value: CHATGPT.client_id }],
    });
    expect(resources.map((r) => r.resourceId)).toEqual([RESOURCE]);
  });

  it.each([
    "http://evil.example/callback",
    "https://evil.example/callback",
    "http://localhost:53123/other",
  ])("refuse the redirect URI %s, which the document does not list", async (redirect) => {
    const target = location(await authorize(CLAUDE_CODE.client_id, redirect));

    expect(target.origin).toBe(baseURL);
    expect(target.pathname).toBe("/api/auth/error");
    expect(target.searchParams.get("error")).toBeTruthy();
  });

  it("refuse a document whose client_id is not its own URL", async () => {
    const response = await authorize(IMPOSTOR_URL, IMPOSTOR.redirect_uris[0]);

    expect(fetchDocument).toHaveBeenCalledWith(IMPOSTOR_URL, expect.anything());
    expect(await clientError(response)).toBe("invalid_client");
    expect(await storedClient(IMPOSTOR_URL)).toBeNull();
  });

  it.each([
    "https://127.0.0.1/client.json",
    "https://localhost/client.json",
    "https://10.0.0.5/client.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/client.json",
  ])("never fetch a document from the private address %s", async (id) => {
    const response = await authorize(id, "https://claude.ai/api/mcp/auth_callback");

    expect(await clientError(response)).toBe("invalid_client");
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("let Claude finish a connection as a public client", async () => {
    const callback = await approve(
      location(await authorize(CLAUDE.client_id, CLAUDE.redirect_uris[0])),
    );
    expect(callback.origin + callback.pathname).toBe(CLAUDE.redirect_uris[0]);

    const response = await token({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: CLAUDE.redirect_uris[0],
      client_id: CLAUDE.client_id,
      code_verifier: CODE_VERIFIER,
      resource: RESOURCE,
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.scope).toBe(SCOPE);
    expect(body.refresh_token).toBeTruthy();
    // Bound to the MCP server and to the project the user picked.
    const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ aud: RESOURCE, project_id: "p1", azp: CLAUDE.client_id });
  });

  it("let ChatGPT finish a connection by signing with the key its document names", async () => {
    const callback = await approve(
      location(await authorize(CHATGPT.client_id, CHATGPT.redirect_uris[0])),
    );
    const exchange = {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: CHATGPT.redirect_uris[0],
      client_id: CHATGPT.client_id,
      code_verifier: CODE_VERIFIER,
      resource: RESOURCE,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    };

    // Without a signature the client is not who it claims to be.
    const unsigned = await token({ ...exchange, client_assertion_type: "" });
    expect((await unsigned.json()).error).toBe("invalid_client");

    const response = await token({ ...exchange, client_assertion: chatgptAssertion() });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.scope).toBe(SCOPE);
    expect(fetchDocument).toHaveBeenCalledWith(CHATGPT.jwks_uri, expect.anything());
  });

  it("leave dynamic registration working", async () => {
    const response = await auth.handler(
      request("/oauth2/register", {
        body: {
          client_name: "Cursor",
          redirect_uris: ["https://cursor.example/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      }),
    );
    expect(response.status).toBe(201);
    const { client_id } = await response.json();

    const target = location(await authorize(client_id, "https://cursor.example/callback"));
    expect(target.pathname).toBe(OAUTH_SELECT_PROJECT_PAGE);
    expect(fetchDocument).not.toHaveBeenCalled();
  });
});
