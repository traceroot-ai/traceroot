/**
 * OAuth discovery for the MCP endpoint (RFC 9728 protected-resource metadata).
 *
 * An assistant that is not given a key calls the endpoint with no credential and
 * is answered 401 with a pointer to this server's metadata, which names the
 * authorization server to sign in with. The server does not verify OAuth tokens
 * itself: like an API key, a token is passed through to the backend, which
 * verifies it (see credential-check.ts for how its verdict becomes a 401). The
 * one thing read here is expiry, so an expired token gets the 401 that makes a
 * client refresh without a round trip to the backend.
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
  new URL(resourceUrl);
  new URL(authorizationServer);
  return { resourceUrl, authorizationServer };
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

/**
 * The `WWW-Authenticate` value for a 401. A missing credential gets a challenge
 * that points at the metadata; a refused one
 * says why with `invalid_token`, which is what makes a client refresh or sign
 * in again. With OAuth off there is no metadata to point at.
 */
export function challenge(
  config: OAuthConfig | undefined,
  error?: { code: "invalid_token"; description: string },
): string {
  const params: string[] = [];
  if (error) {
    params.push(`error="${error.code}"`, `error_description="${quotable(error.description)}"`);
  }
  if (config) {
    params.push(`resource_metadata="${resourceMetadataUrl(config)}"`);
  }
  return params.length > 0 ? `Bearer ${params.join(", ")}` : "Bearer";
}

/** Keep only the characters RFC 6750 allows in a quoted challenge parameter. */
function quotable(text: string): string {
  return text.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, "");
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
