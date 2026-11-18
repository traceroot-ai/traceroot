import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  challenge,
  isExpiredJwt,
  parseOAuthConfig,
  protectedResourceMetadata,
  resourceMetadataPath,
  resourceMetadataUrl,
} from "../oauth.js";

const OAUTH = {
  resourceUrl: "https://mcp.example.com/mcp",
  authorizationServer: "https://app.example.com/api/auth",
};

function jwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(payload)}.signature`;
}

describe("parseOAuthConfig", () => {
  it("is on only when both the resource URL and the issuer are set", () => {
    expect(
      parseOAuthConfig({
        MCP_RESOURCE_URL: OAUTH.resourceUrl,
        MCP_OAUTH_ISSUER: OAUTH.authorizationServer,
      }),
    ).toEqual(OAUTH);
    expect(parseOAuthConfig({ MCP_RESOURCE_URL: OAUTH.resourceUrl })).toBeUndefined();
    expect(parseOAuthConfig({ MCP_OAUTH_ISSUER: OAUTH.authorizationServer })).toBeUndefined();
    expect(parseOAuthConfig({ MCP_RESOURCE_URL: " ", MCP_OAUTH_ISSUER: "" })).toBeUndefined();
  });

  it("refuses a malformed URL at startup rather than serving broken metadata", () => {
    expect(() =>
      parseOAuthConfig({ MCP_RESOURCE_URL: "not a url", MCP_OAUTH_ISSUER: "https://a.example" }),
    ).toThrow();
  });
});

describe("protected-resource metadata", () => {
  it("puts the well-known prefix between host and path", () => {
    expect(resourceMetadataPath(OAUTH)).toBe("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetadataUrl(OAUTH)).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("names the resource, the authorization server and the read scope", () => {
    expect(protectedResourceMetadata(OAUTH)).toEqual({
      resource: OAUTH.resourceUrl,
      authorization_servers: [OAUTH.authorizationServer],
      scopes_supported: ["mcp:read", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "TraceRoot MCP",
    });
  });
});

describe("challenge", () => {
  it("is a bare Bearer when OAuth is off", () => {
    expect(challenge(undefined)).toBe("Bearer");
  });

  it("points at the metadata when OAuth is on", () => {
    expect(challenge(OAUTH)).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("says why a token was refused", () => {
    expect(challenge(OAUTH, { code: "invalid_token", description: "expired" })).toBe(
      'Bearer error="invalid_token", error_description="expired", ' +
        'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("says why a key was refused when OAuth is off", () => {
    expect(challenge(undefined, { code: "invalid_token", description: "Invalid API key" })).toBe(
      'Bearer error="invalid_token", error_description="Invalid API key"',
    );
  });

  it("keeps a description that could break out of its quotes inside them", () => {
    expect(
      challenge(undefined, { code: "invalid_token", description: 'bad "token"\\\n, x="y"' }),
    ).toBe('Bearer error="invalid_token", error_description="bad token, x=y"');
  });
});

describe("isExpiredJwt", () => {
  const now = 1_700_000_000_000;

  it("is true only for a JWT whose exp has passed", () => {
    expect(isExpiredJwt(jwt({ exp: now / 1000 - 1 }), now)).toBe(true);
    expect(isExpiredJwt(jwt({ exp: now / 1000 + 60 }), now)).toBe(false);
  });

  it("leaves everything else to the backend", () => {
    expect(isExpiredJwt("tr-abc", now)).toBe(false);
    expect(isExpiredJwt("a.b", now)).toBe(false);
    expect(isExpiredJwt("a.!!!.c", now)).toBe(false);
    expect(isExpiredJwt(jwt({}), now)).toBe(false);
    expect(isExpiredJwt(jwt({ exp: "soon" }), now)).toBe(false);
  });
});

describe("the endpoint", () => {
  let backendStatus = 200;
  const fetchImpl = vi.fn(async () => {
    if (backendStatus === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ detail: "Invalid token" }), { status: backendStatus });
  });
  beforeEach(() => {
    backendStatus = 200;
    fetchImpl.mockClear();
  });
  const make = (oauth?: typeof OAUTH) =>
    createApp({
      backendUrl: "http://rest:8000",
      allowedHosts: ["mcp.example.com"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      oauth,
    });
  const post = (app: ReturnType<typeof make>, authorization?: string) =>
    app.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "mcp.example.com",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  it("serves the metadata, publicly and cross-origin, when OAuth is on", async () => {
    const response = await make(OAUTH).fetch(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(protectedResourceMetadata(OAUTH));
  });

  it("serves no metadata when OAuth is off", async () => {
    const response = await make().fetch(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    expect(response.status).toBe(404);
  });

  it("answers a missing credential with a 401 that points at the metadata", async () => {
    const response = await post(make(OAUTH));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge(OAUTH));
  });

  it("keeps the bare challenge when OAuth is off", async () => {
    const response = await post(make());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("answers an expired OAuth token with invalid_token so the client refreshes", async () => {
    const response = await post(make(OAUTH), `Bearer ${jwt({ exp: 1 })}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("does not look at expiry when OAuth is off", async () => {
    const response = await post(make(), `Bearer ${jwt({ exp: 1 })}`);
    expect(response.status).not.toBe(401);
  });

  it("lets an unexpired token and an API key through to the backend", async () => {
    const app = make(OAUTH);
    expect((await post(app, `Bearer ${jwt({ exp: Date.now() / 1000 + 600 })}`)).status).not.toBe(
      401,
    );
    expect((await post(app, "Bearer tr-key")).status).not.toBe(401);
  });

  it("answers a token the backend refuses with invalid_token and the metadata pointer", async () => {
    backendStatus = 401;
    const response = await post(make(OAUTH), `Bearer ${jwt({ exp: Date.now() / 1000 + 600 })}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      challenge(OAUTH, { code: "invalid_token", description: "Invalid token" }),
    );
  });

  it("lets a genuine token with no access through, so the tools can say why", async () => {
    backendStatus = 403;
    const response = await post(make(OAUTH), "Bearer tr-key");
    expect(response.status).toBe(200);
  });

  it.each([
    ["is down", 0],
    ["fails", 502],
    ["rate limits", 429],
  ])("does not send the client to sign in again when the backend %s", async (_name, status) => {
    backendStatus = status;
    const response = await post(make(OAUTH), "Bearer tr-key");
    expect(response.status).toBe(200);
  });
});
