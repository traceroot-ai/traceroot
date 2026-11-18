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

import { mcpOAuthProviderOptions } from "./provider-options";

// Real better-auth handlers with the provider configured as in auth.ts, on an
// in-memory database: registration, authorization, token and refresh behave as
// they do in production, without a server or a network.

const baseURL = "http://localhost:3000";
const RESOURCE = "https://mcp.example.com/mcp";
const SCOPE = "mcp:read offline_access";

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
      oauthAccessToken: [],
      oauthRefreshToken: [],
      oauthConsent: [],
      oauthClientAssertion: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA" } } }),
      oauthProvider(mcpOAuthProviderOptions(RESOURCE)),
    ],
  });
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
