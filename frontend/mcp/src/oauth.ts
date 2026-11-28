/**
 * OAuth discovery for the MCP endpoint (RFC 9728 protected-resource metadata).
 *
 * An assistant that is not given a key calls the endpoint with no credential and
 * is answered 401 with a pointer to this server's metadata, which names the
 * authorization server to sign in with. The server does not validate OAuth tokens:
 * like an API key, a token is passed through to the backend, which verifies it.
 * The one thing checked here is expiry, so an expired token gets the 401 that
 * makes a client refresh instead of a tool error it cannot act on.
 */

/** The scope this server needs: read access to one project's data. */
export const MCP_READ_SCOPE = "mcp:read";
/**
 * Lets a client keep the connection with a refresh token instead of sending the
 * user back through sign-in. Grants no access of its own. Listed so the scopes
 * advertised here are the ones the authorization server advertises.
 */
export const REFRESH_SCOPE = "offline_access";

export interface OAuthConfig {
  /** This endpoint's public URL, as an assistant addresses it (the token audience). */
  resourceUrl: string;
  /** Issuer URL of the authorization server the user signs in with. */
  authorizationServer: string;
}

/** Both values set means OAuth is on; either missing leaves the server key-only. */
export function parseOAuthConfig(env: {
  MCP_RESOURCE_URL?: string;
  MCP_OAUTH_ISSUER?: string;
}): OAuthConfig | undefined {
  const resourceUrl = (env.MCP_RESOURCE_URL ?? "").trim();
  const authorizationServer = (env.MCP_OAUTH_ISSUER ?? "").trim();
  if (!resourceUrl || !authorizationServer) return undefined;
  // Fail at startup on a malformed value rather than serving broken metadata.
  const problem = resourceUrlProblem(resourceUrl);
  if (problem) throw new Error(`MCP_RESOURCE_URL ${JSON.stringify(resourceUrl)} ${problem}`);
  new URL(authorizationServer);
  return { resourceUrl, authorizationServer };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What is wrong with a resource URL, or null. Assistants send it back as the
 * token's `resource` and compare it with the metadata's `resource` byte for
 * byte, so it must be the canonical form: https (plain http only on a loopback
 * host, for local runs), the /mcp path with no trailing slash, and no
 * credentials, query or fragment.
 */
export function resourceUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return "must use https";
  }
  if (url.username || url.password) return "must not carry credentials";
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    return "must not have a query or fragment";
  }
  if (!url.pathname.endsWith("/mcp")) return "must end in /mcp, with no trailing slash";
  if (url.toString() !== value) return `is not in canonical form; use ${url.toString()}`;
  return null;
}

/** Where the metadata lives: the well-known prefix goes between host and path (RFC 9728 §3). */
export function resourceMetadataPath(config: OAuthConfig): string {
  const path = new URL(config.resourceUrl).pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-protected-resource${path}`;
}

export function resourceMetadataUrl(config: OAuthConfig): string {
  return new URL(resourceMetadataPath(config), config.resourceUrl).toString();
}

export function protectedResourceMetadata(config: OAuthConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.authorizationServer],
    scopes_supported: [MCP_READ_SCOPE, REFRESH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "TraceRoot MCP",
  };
}

/** The `WWW-Authenticate` value for a 401: bare `Bearer` unless OAuth is on. */
export function challenge(
  config: OAuthConfig | undefined,
  error?: { code: "invalid_token"; description: string },
): string {
  if (!config) return "Bearer";
  const params = [`resource_metadata="${resourceMetadataUrl(config)}"`];
  if (error) {
    params.unshift(`error="${error.code}"`, `error_description="${error.description}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

/**
 * True when the token is a JWT whose `exp` has passed. Only reads the claim to
 * decide which 401 to send; it proves nothing, and the backend verifies the token.
 */
export function isExpiredJwt(token: string, now: number = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && payload.exp * 1000 <= now;
  } catch {
    return false;
  }
}
