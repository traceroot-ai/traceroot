import { describe, expect, it, vi } from "vitest";
import {
  IssuerConfigError,
  authorizationServerMetadataPath,
  verifyIssuer,
} from "../issuer-check.js";
import { parseOAuthConfig, resourceUrlProblem } from "../oauth.js";

const CONFIG = {
  resourceUrl: "https://mcp.example.com/mcp",
  authorizationServer: "https://app.example.com/api/auth",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the resource URL", () => {
  it.each([
    "https://mcp.example.com/mcp",
    "https://example.com/tools/mcp",
    "http://localhost:8200/mcp",
    "http://127.0.0.1:8200/mcp",
  ])("accepts the canonical %s", (url) => {
    expect(resourceUrlProblem(url)).toBeNull();
  });

  it.each([
    ["http://mcp.example.com/mcp", "must use https"],
    ["https://mcp.example.com/mcp/", "must end in /mcp"],
    ["https://mcp.example.com/", "must end in /mcp"],
    ["https://mcp.example.com/mcp?x=1", "query or fragment"],
    ["https://mcp.example.com/mcp?", "query or fragment"],
    ["https://mcp.example.com/mcp#a", "query or fragment"],
    ["https://u:p@mcp.example.com/mcp", "credentials"],
    ["https://MCP.example.com/mcp", "use https://mcp.example.com/mcp"],
    ["https://mcp.example.com:443/mcp", "use https://mcp.example.com/mcp"],
    ["not a url", "is not a URL"],
  ])("refuses %s", (url, problem) => {
    expect(resourceUrlProblem(url)).toContain(problem);
  });

  it("fails startup on a non-canonical value", () => {
    expect(() =>
      parseOAuthConfig({
        MCP_RESOURCE_URL: "https://mcp.example.com/mcp/",
        MCP_OAUTH_ISSUER: CONFIG.authorizationServer,
      }),
    ).toThrow("MCP_RESOURCE_URL");
  });
});

describe("the issuer check", () => {
  it("puts the well-known prefix between the host and the issuer's path", () => {
    expect(authorizationServerMetadataPath("https://app.example.com/api/auth")).toBe(
      "/.well-known/oauth-authorization-server/api/auth",
    );
  });

  it("passes when the metadata names exactly the configured issuer, read inside the network", async () => {
    const fetchImpl = vi.fn(async () => json({ issuer: CONFIG.authorizationServer }));
    await verifyIssuer(CONFIG, { internalOrigin: "http://web:3000", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://web:3000/.well-known/oauth-authorization-server/api/auth",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("reads the public metadata URL when no internal origin is given", async () => {
    const fetchImpl = vi.fn(async () => json({ issuer: CONFIG.authorizationServer }));
    await verifyIssuer(CONFIG, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://app.example.com/.well-known/oauth-authorization-server/api/auth",
    );
  });

  it.each([
    ["a trailing slash", "https://app.example.com/api/auth/"],
    ["another scheme", "http://app.example.com/api/auth"],
    ["another host", "https://auth.example.com/api/auth"],
  ])("refuses at once an issuer that differs by %s", async (_label, issuer) => {
    const fetchImpl = vi.fn(async () => json({ issuer }));
    await expect(verifyIssuer(CONFIG, { fetchImpl, attempts: 5, delayMs: 0 })).rejects.toThrow(
      IssuerConfigError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect, which means the web app serves no metadata", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: "/auth/sign-in" } }),
    );
    await expect(verifyIssuer(CONFIG, { fetchImpl, delayMs: 0 })).rejects.toThrow(
      /redirects \(307\)/,
    );
  });

  it("refuses metadata without an issuer", async () => {
    const fetchImpl = vi.fn(async () => json({ authorization_endpoint: "x" }));
    await expect(verifyIssuer(CONFIG, { fetchImpl, delayMs: 0 })).rejects.toThrow("no issuer");
  });

  it("waits for an authorization server that is still starting, then gives up", async () => {
    const starting = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(json({ issuer: CONFIG.authorizationServer }));
    await verifyIssuer(CONFIG, { fetchImpl: starting, delayMs: 0 });
    expect(starting).toHaveBeenCalledTimes(3);

    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const failure = verifyIssuer(CONFIG, { fetchImpl: down, attempts: 3, delayMs: 0 });
    await expect(failure).rejects.toThrow("did not answer after 3 attempts (fetch failed)");
    await expect(failure).rejects.not.toBeInstanceOf(IssuerConfigError);
  });
});
